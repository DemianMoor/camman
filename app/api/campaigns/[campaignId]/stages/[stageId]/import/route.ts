import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import {
  campaign_stages,
  campaigns,
  clickers,
  contacts,
  opt_out_brands,
  opt_outs,
  stage_result_rows,
  stage_results_imports,
} from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { logCampaignEvent } from "@/lib/campaign-events";
import { CSV_MAX_BYTES, parseCsv } from "@/lib/imports/parse-csv";
import {
  deriveOutcome,
  OUTCOME_PRIORITY,
  type OutcomeResult,
  type ParsedRow,
} from "@/lib/imports/outcome";
import { can } from "@/lib/permissions";
import { recomputeStageTotalCost } from "@/lib/stages/total-cost";
import {
  mappingColumnsSchema,
  statusValueMapSchema,
} from "@/lib/validators/result-import-mappings";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const importSchema = z.object({
  csv_content: z.string().min(1),
  mapping: mappingColumnsSchema,
  status_value_map: statusValueMapSchema,
  mapping_id: z.number().int().positive().nullable().optional(),
  filename: z.string().trim().max(255).nullable().optional(),
  // When set, this single value is used as the import's total_cost_added
  // instead of summing the per-row costs from the CSV. Useful when the
  // provider doesn't expose per-row costs (or when the operator wants to
  // record a flat lump-sum). Per-row `cost` values are still parsed and
  // stored on stage_result_rows for auditing.
  total_cost_override: z
    .number()
    .nonnegative()
    .finite()
    .nullable()
    .optional(),
  confirm: z.literal(true),
});

const CHUNK_SIZE = 1000;

// Stage results import. Transactional end-to-end: any DB error rolls back
// the whole thing (no partial imports). Idempotency is enforced by the
// UNIQUE(stage_id, phone_number) on stage_result_rows — a re-import of the
// same CSV hits ON CONFLICT DO NOTHING and contributes 0 to the counters.
//
// Opt-outs & clickers propagation: for the propagation step we set
// created_opt_out_id / created_clicker_id on EVERY result row whose outcome
// triggers propagation, regardless of whether the opt_out/clicker row was
// freshly inserted by this import or already existed. That makes revert's
// cross-import preservation rule trivial: if any non-reverted result row
// still references the opt_out/clicker, the revert leaves it alone.
export async function POST(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "result_imports.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId, stageId } = await params;
  const cid = parseId(campaignId);
  const sid = parseId(stageId);
  if (cid === null || sid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = importSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const {
    csv_content,
    mapping,
    status_value_map,
    mapping_id,
    filename,
    total_cost_override,
  } = parsed.data;

  if (Buffer.byteLength(csv_content, "utf-8") > CSV_MAX_BYTES) {
    return apiError(
      400,
      "CSV exceeds 25MB limit",
      API_ERROR_CODES.VALIDATION,
      { reason: "csv_too_large" },
    );
  }

  // Verify stage ↔ campaign ↔ org, and pull the brand+provider context we
  // need for opt_out/clicker propagation.
  const stageCtx = await db
    .select({
      stage_id: campaign_stages.id,
      sms_provider_id: campaign_stages.sms_provider_id,
      brand_id: campaigns.brand_id,
      offer_id: campaigns.offer_id,
    })
    .from(campaign_stages)
    .innerJoin(campaigns, eq(campaigns.id, campaign_stages.campaign_id))
    .where(
      and(
        eq(campaign_stages.id, sid),
        eq(campaign_stages.campaign_id, cid),
        eq(campaign_stages.org_id, orgId),
      ),
    )
    .limit(1);
  if (!stageCtx[0]) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "stage",
    });
  }
  const { brand_id: campaignBrandId, sms_provider_id: stageProviderId } =
    stageCtx[0];

  const { rows, submitted } = parseCsv(csv_content, mapping);

  // Filter to rows with valid phones; pre-compute outcomes; collapse
  // duplicates by phone keeping the HIGHEST-priority outcome (see
  // OUTCOME_PRIORITY in lib/imports/outcome.ts). Provider CSVs commonly
  // include multiple events per recipient (delivered + clicked + STOP);
  // we store one row per phone in stage_result_rows and want it tagged
  // with the most consequential signal.
  type ProcessableRow = {
    phone_number: string;
    parsed: ParsedRow;
    outcome: OutcomeResult;
  };
  const byPhone = new Map<string, ProcessableRow>();
  for (const r of rows) {
    if (r.phone_number === null) continue;
    const o = deriveOutcome(r, status_value_map ?? undefined);
    const candidate: ProcessableRow = {
      phone_number: r.phone_number,
      parsed: r,
      outcome: o,
    };
    const existing = byPhone.get(r.phone_number);
    if (
      !existing ||
      OUTCOME_PRIORITY[candidate.outcome.outcome] >
        OUTCOME_PRIORITY[existing.outcome.outcome]
    ) {
      byPhone.set(r.phone_number, candidate);
    }
  }
  const processable: ProcessableRow[] = Array.from(byPhone.values());

  // Run the entire write path in one transaction.
  const result = await db.transaction(async (tx) => {
    // 1. Create the import row up front so stage_result_rows can FK to it.
    //    processed_rows starts at 0; we'll update after the loop.
    const [importRow] = await tx
      .insert(stage_results_imports)
      .values({
        org_id: orgId,
        campaign_id: cid,
        stage_id: sid,
        imported_by_user_id: user.id,
        mapping_id: mapping_id ?? null,
        filename: filename ?? null,
        submitted_rows: submitted,
        processed_rows: 0,
      })
      .returning();

    // 2. Upsert contacts in chunks, building a phone → contact_id map.
    //    `processable` is already unique by phone (collapsed above via
    //    OUTCOME_PRIORITY), so a single INSERT per phone is sufficient —
    //    no risk of Postgres's "ON CONFLICT DO UPDATE command cannot
    //    affect row a second time" error.
    const phoneToContact = new Map<string, string>();
    for (let i = 0; i < processable.length; i += CHUNK_SIZE) {
      const chunk = processable.slice(i, i + CHUNK_SIZE);
      if (chunk.length === 0) continue;
      const values = chunk.map((p) => ({
        org_id: orgId,
        phone_number: p.phone_number,
      }));
      const upserted = await tx
        .insert(contacts)
        .values(values)
        .onConflictDoUpdate({
          target: [contacts.org_id, contacts.phone_number],
          set: { updated_at: drizzleSql`now()` },
        })
        .returning({ id: contacts.id, phone_number: contacts.phone_number });
      for (const c of upserted) phoneToContact.set(c.phone_number, c.id);
    }

    // 3. Pre-load existing opt-outs (by contact_id) for this org so we don't
    //    double-insert when many rows in the same CSV exclude the same
    //    contact (rare, but possible). Scrubbed and bounced rows also
    //    propagate into opt_outs (with their own `reason`), so all three
    //    outcomes share this lookup map — any existing opt_outs row is
    //    enough to satisfy the exclusion, regardless of its reason.
    const exclusionCandidates = processable
      .filter(
        (p) =>
          p.outcome.outcome === "optout" ||
          p.outcome.outcome === "scrubbed" ||
          p.outcome.outcome === "bounced",
      )
      .map((p) => phoneToContact.get(p.phone_number))
      .filter((cid): cid is string => !!cid);
    const clickerCandidates = processable
      .filter((p) => p.outcome.outcome === "clicker")
      .map((p) => phoneToContact.get(p.phone_number))
      .filter((cid): cid is string => !!cid);

    // Look up existing opt_outs (per-org) for the candidate contacts. We
    // store the FIRST opt_out_id per contact — if multiple exist (rare),
    // it doesn't matter which we reference.
    const existingOptoutByContact = new Map<string, number>();
    if (exclusionCandidates.length > 0) {
      const uniq = Array.from(new Set(exclusionCandidates));
      for (let i = 0; i < uniq.length; i += CHUNK_SIZE) {
        const chunk = uniq.slice(i, i + CHUNK_SIZE);
        const found = await tx
          .select({
            id: opt_outs.id,
            contact_id: opt_outs.contact_id,
          })
          .from(opt_outs)
          .where(
            and(
              eq(opt_outs.org_id, orgId),
              inArray(opt_outs.contact_id, chunk),
            ),
          );
        for (const row of found) {
          if (!existingOptoutByContact.has(row.contact_id)) {
            existingOptoutByContact.set(row.contact_id, row.id);
          }
        }
      }
    }

    // Existing clickers per (contact_id, brand_id). brand_id is required on
    // clickers; we only insert one per (contact, brand) regardless of how
    // many CSVs reference it.
    const existingClickerByContact = new Map<string, number>();
    if (clickerCandidates.length > 0 && campaignBrandId !== null) {
      const uniq = Array.from(new Set(clickerCandidates));
      for (let i = 0; i < uniq.length; i += CHUNK_SIZE) {
        const chunk = uniq.slice(i, i + CHUNK_SIZE);
        const found = await tx
          .select({
            id: clickers.id,
            contact_id: clickers.contact_id,
          })
          .from(clickers)
          .where(
            and(
              eq(clickers.org_id, orgId),
              eq(clickers.brand_id, campaignBrandId),
              inArray(clickers.contact_id, chunk),
            ),
          );
        for (const row of found) {
          if (!existingClickerByContact.has(row.contact_id)) {
            existingClickerByContact.set(row.contact_id, row.id);
          }
        }
      }
    }

    // 4. Resolve propagation. Scrubbed/bounced share the opt_outs path
    //    (tagged via the `reason` column) so the audience-snapshot
    //    exclusion query handles them uniformly. Unlike STOP opt-outs,
    //    they do NOT get an opt_out_brands row — they're universal, not
    //    brand-specific.
    //
    //    Perf note: an earlier draft did per-row INSERT … RETURNING for
    //    each new opt_out / clicker. With opt-outs at <2% of total rows
    //    that was fine, but scrubbed/bounced changed the math (10K-row
    //    CSVs commonly have ~10% scrubbed → 1,000+ INSERTs in one
    //    transaction → Vercel function timeout). Now we collect the
    //    needed rows up front and bulk-insert in CHUNK_SIZE batches —
    //    ~2 roundtrips total instead of 1,000+.
    //
    //    Within-batch dedup: a contact appearing multiple times in the
    //    CSV gets ONE opt_out row. The FIRST outcome seen for that
    //    contact determines `reason` — same semantics as the prior
    //    per-row loop.

    // 4a. Plan: walk processable, gather unique (contact_id → reason /
    //     phone) tuples for rows that need a NEW opt_out / clicker.
    const newOptOutsByContact = new Map<
      string,
      { phone_number: string; reason: "opt_out" | "scrubbed" | "bounced" }
    >();
    const newClickersByContact = new Map<
      string,
      { phone_number: string }
    >();
    for (let i = 0; i < processable.length; i++) {
      const p = processable[i];
      const contactId = phoneToContact.get(p.phone_number);
      if (!contactId) continue;

      const isExclusionOutcome =
        p.outcome.outcome === "optout" ||
        p.outcome.outcome === "scrubbed" ||
        p.outcome.outcome === "bounced";

      if (isExclusionOutcome) {
        if (
          !existingOptoutByContact.has(contactId) &&
          !newOptOutsByContact.has(contactId)
        ) {
          let reason: "opt_out" | "scrubbed" | "bounced";
          if (p.outcome.outcome === "optout") reason = "opt_out";
          else if (p.outcome.outcome === "scrubbed") reason = "scrubbed";
          else reason = "bounced";
          newOptOutsByContact.set(contactId, {
            phone_number: p.phone_number,
            reason,
          });
        }
      } else if (
        p.outcome.outcome === "clicker" &&
        campaignBrandId !== null
      ) {
        if (
          !existingClickerByContact.has(contactId) &&
          !newClickersByContact.has(contactId)
        ) {
          newClickersByContact.set(contactId, {
            phone_number: p.phone_number,
          });
        }
      }
    }

    // 4b. Bulk-insert new opt_outs in chunks; RETURNING (id, contact_id)
    //     so we can populate existingOptoutByContact. Each (contact_id)
    //     in this set is unique by Map construction, so no conflict.
    const newOptOutEntries = Array.from(newOptOutsByContact.entries());
    for (let i = 0; i < newOptOutEntries.length; i += CHUNK_SIZE) {
      const chunk = newOptOutEntries.slice(i, i + CHUNK_SIZE);
      if (chunk.length === 0) continue;
      const inserted = await tx
        .insert(opt_outs)
        .values(
          chunk.map(([contactId, v]) => ({
            org_id: orgId,
            contact_id: contactId,
            phone_number: v.phone_number,
            source: `stage-import:${importRow.id}`,
            reason: v.reason,
          })),
        )
        .returning({
          id: opt_outs.id,
          contact_id: opt_outs.contact_id,
        });
      for (const row of inserted) {
        existingOptoutByContact.set(row.contact_id, row.id);
      }
    }

    // 4c. Bulk-insert opt_out_brands for the subset whose `reason` is
    //     'opt_out' (scrubbed/bounced are universal — no brand junction).
    if (campaignBrandId !== null) {
      const brandJunctionValues: Array<{
        opt_out_id: number;
        brand_id: number;
      }> = [];
      for (const [contactId, v] of newOptOutEntries) {
        if (v.reason !== "opt_out") continue;
        const optOutId = existingOptoutByContact.get(contactId);
        if (optOutId === undefined) continue; // defensive; unreachable
        brandJunctionValues.push({
          opt_out_id: optOutId,
          brand_id: campaignBrandId,
        });
      }
      for (let i = 0; i < brandJunctionValues.length; i += CHUNK_SIZE) {
        const chunk = brandJunctionValues.slice(i, i + CHUNK_SIZE);
        if (chunk.length === 0) continue;
        await tx
          .insert(opt_out_brands)
          .values(chunk)
          .onConflictDoNothing();
      }
    }

    // 4d. Bulk-insert new clickers. Clickers are gated on a brand_id
    //     (FK NOT NULL), so we only do this when the campaign has one.
    const newClickerEntries = Array.from(newClickersByContact.entries());
    if (campaignBrandId !== null) {
      for (let i = 0; i < newClickerEntries.length; i += CHUNK_SIZE) {
        const chunk = newClickerEntries.slice(i, i + CHUNK_SIZE);
        if (chunk.length === 0) continue;
        const inserted = await tx
          .insert(clickers)
          .values(
            chunk.map(([contactId, v]) => ({
              org_id: orgId,
              contact_id: contactId,
              phone_number: v.phone_number,
              brand_id: campaignBrandId,
              provider_id: stageProviderId ?? null,
              offer_id: stageCtx[0].offer_id ?? null,
              source: `stage-import:${importRow.id}`,
            })),
          )
          .returning({
            id: clickers.id,
            contact_id: clickers.contact_id,
          });
        for (const row of inserted) {
          existingClickerByContact.set(row.contact_id, row.id);
        }
      }
    }

    // 4e. Map each processable row → its opt_out / clicker id, using the
    //     now-fully-populated existingOptoutByContact / existingClicker-
    //     ByContact maps. Per-row, no DB roundtrips.
    const rowOptOutId = new Map<number, number>();
    const rowClickerId = new Map<number, number>();
    for (let i = 0; i < processable.length; i++) {
      const p = processable[i];
      const contactId = phoneToContact.get(p.phone_number);
      if (!contactId) continue;

      const isExclusionOutcome =
        p.outcome.outcome === "optout" ||
        p.outcome.outcome === "scrubbed" ||
        p.outcome.outcome === "bounced";

      if (isExclusionOutcome) {
        const ooId = existingOptoutByContact.get(contactId);
        if (ooId !== undefined) rowOptOutId.set(i, ooId);
      } else if (p.outcome.outcome === "clicker") {
        const clId = existingClickerByContact.get(contactId);
        if (clId !== undefined) rowClickerId.set(i, clId);
      }
    }

    // 5. Bulk-insert stage_result_rows in chunks. ON CONFLICT DO NOTHING
    //    enforces idempotency; RETURNING phone_number tells us which rows
    //    actually got inserted (vs were skipped as dupes). We then iterate
    //    the source rows and sum counters only for the inserted set.
    //
    //    Critical perf bit: the per-row INSERT loop in the previous draft
    //    cost ~1 roundtrip per row → seconds for thousands of rows. This
    //    batches to one roundtrip per CHUNK_SIZE rows.
    const insertedPhones = new Set<string>();
    for (let i = 0; i < processable.length; i += CHUNK_SIZE) {
      const chunkIdx = i;
      const chunk = processable.slice(i, i + CHUNK_SIZE);
      if (chunk.length === 0) continue;
      const values = chunk.map((p, j) => ({
        org_id: orgId,
        import_id: importRow.id,
        stage_id: sid,
        phone_number: p.phone_number,
        contact_id: phoneToContact.get(p.phone_number) ?? null,
        outcome: p.outcome.outcome,
        cost: p.parsed.cost != null ? String(p.parsed.cost) : null,
        raw_row: p.parsed.raw,
        created_opt_out_id: rowOptOutId.get(chunkIdx + j) ?? null,
        created_clicker_id: rowClickerId.get(chunkIdx + j) ?? null,
      }));
      const returned = await tx
        .insert(stage_result_rows)
        .values(values)
        .onConflictDoNothing({
          target: [stage_result_rows.stage_id, stage_result_rows.phone_number],
        })
        .returning({ phone_number: stage_result_rows.phone_number });
      for (const r of returned) insertedPhones.add(r.phone_number);
    }

    // 6. Aggregate counters only over the rows that actually got inserted.
    let processedRows = 0;
    let deliveredAdded = 0;
    let failedAdded = 0;
    let optoutsAdded = 0;
    let clickersAdded = 0;
    let scrubbedAdded = 0;
    let bouncedAdded = 0;
    let totalCostFromRows = 0;
    for (const p of processable) {
      if (!insertedPhones.has(p.phone_number)) continue;
      processedRows++;
      if (p.outcome.is_delivered) deliveredAdded++;
      if (p.outcome.is_failed) failedAdded++;
      if (p.outcome.is_optout) optoutsAdded++;
      if (p.outcome.is_clicker) clickersAdded++;
      if (p.outcome.is_scrubbed) scrubbedAdded++;
      if (p.outcome.is_bounced) bouncedAdded++;
      if (p.parsed.cost != null) totalCostFromRows += p.parsed.cost;
    }
    // Operator-supplied total wins over the per-row sum. When the override
    // is null/undefined, fall back to the CSV-derived sum.
    const totalCostAdded =
      total_cost_override != null && total_cost_override !== undefined
        ? total_cost_override
        : totalCostFromRows;

    // 7. Update the import row's final counters.
    await tx
      .update(stage_results_imports)
      .set({
        processed_rows: processedRows,
        delivered_added: deliveredAdded,
        failed_added: failedAdded,
        optouts_added: optoutsAdded,
        clickers_added: clickersAdded,
        scrubbed_added: scrubbedAdded,
        bounced_added: bouncedAdded,
        total_cost_added: String(totalCostAdded),
      })
      .where(eq(stage_results_imports.id, importRow.id));

    // 8. Update the stage's running counters. Note: click_count and
    //    opt_out_count are auto-owned (Keitaro / TextHub polls overwrite them
    //    for tracked stages), so a CSV contribution here is authoritative only
    //    until the next poll for stages that have upstream data.
    if (processedRows > 0) {
      const stageUpdate: Record<string, unknown> = {
        sms_count: drizzleSql`${campaign_stages.sms_count} + ${processedRows}`,
        delivered_count: drizzleSql`${campaign_stages.delivered_count} + ${deliveredAdded}`,
        opt_out_count: drizzleSql`${campaign_stages.opt_out_count} + ${optoutsAdded}`,
        click_count: drizzleSql`${campaign_stages.click_count} + ${clickersAdded}`,
        scrubbed_count: drizzleSql`${campaign_stages.scrubbed_count} + ${scrubbedAdded}`,
        bounced_count: drizzleSql`${campaign_stages.bounced_count} + ${bouncedAdded}`,
      };
      // Total Cost ownership: an import that carries a real cost is the
      // provider's actual billed figure, so it takes the field manual.
      // REPLACE a previously auto-derived (synthetic cost_per_sms) value on the
      // first cost-bearing import; ACCUMULATE across repeated imports of an
      // already-manual stage. A zero-cost import doesn't seize the field —
      // the stage stays in auto mode and its derived cost is refreshed below
      // against the just-updated sms_count / opt_out_count.
      if (totalCostAdded > 0) {
        stageUpdate.total_cost = drizzleSql`CASE WHEN ${campaign_stages.total_cost_manual}
            THEN ${campaign_stages.total_cost} + ${String(totalCostAdded)}
            ELSE ${String(totalCostAdded)} END`;
        stageUpdate.total_cost_manual = true;
      }
      await tx
        .update(campaign_stages)
        .set(stageUpdate)
        .where(
          and(
            eq(campaign_stages.id, sid),
            eq(campaign_stages.org_id, orgId),
          ),
        );
      // Refresh the derived cost for stages still in auto mode (no-op once the
      // stage is manual / just became manual above).
      if (totalCostAdded <= 0) {
        await recomputeStageTotalCost(tx, sid);
      }
    }

    await logCampaignEvent(tx, {
      orgId,
      campaignId: cid,
      stageId: sid,
      actorUserId: user.id,
      eventType: "results_imported",
      summary: `Results imported: ${processedRows.toLocaleString()} rows (${deliveredAdded} delivered, ${optoutsAdded} opt-outs, ${clickersAdded} clickers)`,
      metadata: {
        import_id: importRow.id,
        processed_rows: processedRows,
        delivered_added: deliveredAdded,
        failed_added: failedAdded,
        optouts_added: optoutsAdded,
        clickers_added: clickersAdded,
      },
    });

    return {
      id: importRow.id,
      submitted_rows: submitted,
      processed_rows: processedRows,
      delivered_added: deliveredAdded,
      failed_added: failedAdded,
      optouts_added: optoutsAdded,
      clickers_added: clickersAdded,
      scrubbed_added: scrubbedAdded,
      bounced_added: bouncedAdded,
      total_cost_added: totalCostAdded,
      skipped_idempotent: processable.length - processedRows,
    };
  });

  return NextResponse.json(result, { status: 201 });
}
