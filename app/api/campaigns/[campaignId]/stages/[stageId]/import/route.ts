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
import { CSV_MAX_BYTES, parseCsv } from "@/lib/imports/parse-csv";
import {
  deriveOutcome,
  type OutcomeResult,
  type ParsedRow,
} from "@/lib/imports/outcome";
import { can } from "@/lib/permissions";
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

  // Filter to rows with valid phones; pre-compute outcomes so we can do the
  // contacts upsert in chunks then map back.
  type ProcessableRow = {
    phone_number: string;
    parsed: ParsedRow;
    outcome: OutcomeResult;
  };
  const processable: ProcessableRow[] = [];
  for (const r of rows) {
    if (r.phone_number === null) continue;
    const o = deriveOutcome(r, status_value_map ?? undefined);
    processable.push({
      phone_number: r.phone_number,
      parsed: r,
      outcome: o,
    });
  }

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
    const phoneToContact = new Map<string, string>();
    for (let i = 0; i < processable.length; i += CHUNK_SIZE) {
      const chunk = processable.slice(i, i + CHUNK_SIZE);
      const values = chunk.map((p) => ({
        org_id: orgId,
        phone_number: p.phone_number,
      }));
      if (values.length === 0) continue;
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

    // 4. Resolve propagation: for each optout/scrubbed/bounced/clicker row,
    //    either reuse the existing opt_out/clicker for this org (per-brand
    //    for clickers), or insert a new one. These are usually a small
    //    fraction of total rows so per-row roundtrips are acceptable.
    //    Within-batch dedup avoids a second roundtrip when the same
    //    contact appears twice.
    //
    //    Scrubbed/bounced share the opt_outs propagation path (tagged via
    //    the `reason` column) so the audience-snapshot exclusion query
    //    handles them uniformly. Unlike STOP opt-outs, they do NOT get an
    //    opt_out_brands row — they're universal, not brand-specific.
    const rowOptOutId = new Map<number, number>(); // processable idx → opt_out id
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
        const existing = existingOptoutByContact.get(contactId);
        if (existing !== undefined) {
          rowOptOutId.set(i, existing);
        } else {
          const reason = p.outcome.outcome === "optout"
            ? "opt_out"
            : p.outcome.outcome; // "scrubbed" | "bounced"
          const [newRow] = await tx
            .insert(opt_outs)
            .values({
              org_id: orgId,
              contact_id: contactId,
              phone_number: p.phone_number,
              source: `stage-import:${importRow.id}`,
              reason,
            })
            .returning({ id: opt_outs.id });
          existingOptoutByContact.set(contactId, newRow.id);
          rowOptOutId.set(i, newRow.id);
          // Only STOP opt-outs are brand-scoped. Scrubbed/bounced are
          // universal — non-mobile / carrier-rejected numbers are
          // unsendable for ANY brand in the org.
          if (p.outcome.outcome === "optout" && campaignBrandId !== null) {
            await tx
              .insert(opt_out_brands)
              .values({
                opt_out_id: newRow.id,
                brand_id: campaignBrandId,
              })
              .onConflictDoNothing();
          }
        }
      } else if (
        p.outcome.outcome === "clicker" &&
        campaignBrandId !== null
      ) {
        const existing = existingClickerByContact.get(contactId);
        if (existing !== undefined) {
          rowClickerId.set(i, existing);
        } else {
          const [newRow] = await tx
            .insert(clickers)
            .values({
              org_id: orgId,
              contact_id: contactId,
              phone_number: p.phone_number,
              brand_id: campaignBrandId,
              provider_id: stageProviderId ?? null,
              offer_id: stageCtx[0].offer_id ?? null,
              source: `stage-import:${importRow.id}`,
            })
            .returning({ id: clickers.id });
          existingClickerByContact.set(contactId, newRow.id);
          rowClickerId.set(i, newRow.id);
        }
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

    // 8. Update the stage's running counters.
    if (processedRows > 0) {
      await tx
        .update(campaign_stages)
        .set({
          sms_count: drizzleSql`${campaign_stages.sms_count} + ${processedRows}`,
          delivered_count: drizzleSql`${campaign_stages.delivered_count} + ${deliveredAdded}`,
          opt_out_count: drizzleSql`${campaign_stages.opt_out_count} + ${optoutsAdded}`,
          click_count: drizzleSql`${campaign_stages.click_count} + ${clickersAdded}`,
          scrubbed_count: drizzleSql`${campaign_stages.scrubbed_count} + ${scrubbedAdded}`,
          bounced_count: drizzleSql`${campaign_stages.bounced_count} + ${bouncedAdded}`,
          total_cost: drizzleSql`${campaign_stages.total_cost} + ${String(totalCostAdded)}`,
        })
        .where(
          and(
            eq(campaign_stages.id, sid),
            eq(campaign_stages.org_id, orgId),
          ),
        );
    }

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
