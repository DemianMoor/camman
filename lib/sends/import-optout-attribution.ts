import { fromZonedTime } from "date-fns-tz";
import { sql } from "drizzle-orm";

import { validatePhone } from "@/lib/phone-validation";
import {
  latestSendForAttribution,
  type Executor,
} from "@/lib/sends/poll-opt-outs";
import { recomputeStageTotalCost } from "@/lib/stages/total-cost";

// Manual opt-out import WITH campaign/stage attribution. This is the timestamped
// counterpart to /api/opt-outs/upload's plain phone-list path: every row carries
// the moment the recipient replied STOP, and we reverse-match that to the single
// most-recent stage that sent to the number — the SAME rule the live TextHub
// poller uses (latestSendForAttribution), so the UI import and the poller can't
// pick different stages for the same input.
//
// Dedup rules (operator-specified):
//   1. A number that ALREADY has an opt_out in the org is skipped entirely — no
//      new opt_out, no re-attribution to a different campaign/stage. Numbers stay
//      credited to the stage that first suppressed them.
//   2. When the file lists the same number more than once, only the EARLIEST
//      reply time is kept (that's the real STOP; later rows are export noise).
//
// No in-window send ⇒ the opt_out is still created (brand-scoped suppression),
// just with no attribution — counted `unattributed`, exactly what "add to the
// suppression list" means for a number with no send history.

const INSERT_CHUNK = 1000;

export interface OptOutImportEntry {
  phone: string; // raw, as it appears in the file
  received_at: string; // ISO-8601 (with offset/Z) OR naive wall-clock
}

export interface OptOutImportArgs {
  orgId: string;
  entries: OptOutImportEntry[];
  // IANA zone used to interpret NAIVE timestamps (no offset). Ignored for rows
  // that already carry an offset. TextHub exports are "America/Denver".
  timezone: string;
  brandIds: number[];
  providerIds: number[];
  source: string | null;
  assignToGroupIds: number[];
}

// Minimal shape of the phone validator the importer needs.
type PhoneValidator = (raw: string) => {
  valid: boolean;
  normalized: string | null;
  error?: string;
};

export interface OptOutImportDeps {
  // Overridable only so the tsx test harness can bypass libphonenumber, whose
  // metadata won't load under tsx (see scripts/import-texthub-optouts.ts). The
  // production route always uses the default (canonical) validatePhone.
  validatePhone?: PhoneValidator;
}

export interface OptOutImportResult {
  submitted: number; // rows in the file
  valid: number; // rows with a parseable phone AND timestamp
  invalid: number; // rows dropped for a bad phone or bad timestamp
  invalid_samples: { input: string; error: string }[];
  duplicates_in_input: number; // extra rows collapsed to the earliest per number
  // Always 0 — opt-outs are append-only; kept so the shared upload result
  // screen (PhoneUploadForm) can render this field uniformly.
  duplicates_in_db: number;
  skipped_already_opted_out: number; // numbers already suppressed → left alone
  inserted: number; // new opt_outs created
  attributed: number; // opt_outs credited to a stage
  unattributed: number; // opt_outs with no in-window send (suppression only)
  affected_stages: number[];
}

const INVALID_SAMPLE_LIMIT = 20;

// Accepts "YYYY-MM-DD HH:MM[:SS]", "M/D/YYYY H:MM[:SS]" (naive → interpreted in
// `tz`), or anything Date can parse that carries a zone (ISO 8601 offset/Z).
// Returns a UTC Date, or null when unparseable.
export function parseReplyTime(raw: string, tz: string): Date | null {
  const s = (raw ?? "").trim();
  if (!s) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (iso) {
    const [, Y, Mo, D, H, Mi, Se] = iso;
    const d = fromZonedTime(`${Y}-${Mo}-${D}T${H}:${Mi}:${Se ?? "00"}`, tz);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (us) {
    const [, Mo, D, Y, H, Mi, Se] = us;
    const naive =
      `${Y}-${Mo.padStart(2, "0")}-${D.padStart(2, "0")}T` +
      `${H.padStart(2, "0")}:${Mi}:${(Se ?? "00").padStart(2, "0")}`;
    const d = fromZonedTime(naive, tz);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Fallback: rows that already encode an offset (e.g. "2026-07-01T12:00:00-04:00").
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Raw-SQL IN(...) list. drizzle's `= ANY(${array})` binds a Postgres array param
// that the query planner mis-costs here; an inlined IN list keeps the index scan.
function inList(values: (string | number)[]) {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

// Runs the whole import against the given executor. The CALLER owns the
// transaction (the route wraps this in db.transaction; the test wraps it in a
// rolled-back tx) so contact upsert + opt_out + junctions + attribution + counter
// bumps + cost recompute all commit or roll back together.
export async function importOptOutsWithAttribution(
  exec: Executor,
  args: OptOutImportArgs,
  deps: OptOutImportDeps = {},
): Promise<OptOutImportResult> {
  const { orgId, entries, timezone, brandIds, providerIds, source } = args;
  const validate = deps.validatePhone ?? validatePhone;
  const submitted = entries.length;

  // 1. Validate phone + timestamp per row, keeping them paired.
  const invalid_samples: { input: string; error: string }[] = [];
  let invalid = 0;
  // normalized phone → earliest reply time (rule 2: keep the earliest).
  const earliestByPhone = new Map<string, Date>();
  let duplicates_in_input = 0;

  for (const e of entries) {
    const parsed = validate(e.phone);
    if (!parsed.valid || !parsed.normalized) {
      invalid++;
      if (invalid_samples.length < INVALID_SAMPLE_LIMIT)
        invalid_samples.push({ input: e.phone, error: parsed.error ?? "Invalid phone number" });
      continue;
    }
    const when = parseReplyTime(e.received_at, timezone);
    if (!when) {
      invalid++;
      if (invalid_samples.length < INVALID_SAMPLE_LIMIT)
        invalid_samples.push({ input: `${e.phone} @ ${e.received_at}`, error: "Invalid reply time" });
      continue;
    }
    const prev = earliestByPhone.get(parsed.normalized);
    if (prev) {
      duplicates_in_input++;
      if (when < prev) earliestByPhone.set(parsed.normalized, when);
    } else {
      earliestByPhone.set(parsed.normalized, when);
    }
  }

  const valid = earliestByPhone.size + duplicates_in_input;

  const empty: OptOutImportResult = {
    submitted,
    valid,
    invalid,
    invalid_samples,
    duplicates_in_input,
    duplicates_in_db: 0,
    skipped_already_opted_out: 0,
    inserted: 0,
    attributed: 0,
    unattributed: 0,
    affected_stages: [],
  };
  if (earliestByPhone.size === 0) return empty;

  const candidatePhones = [...earliestByPhone.keys()];

  // 2. Skip numbers that already have ANY opt_out in this org (rule 1).
  const alreadyOptedOut = new Set<string>();
  for (let i = 0; i < candidatePhones.length; i += INSERT_CHUNK) {
    const chunk = candidatePhones.slice(i, i + INSERT_CHUNK);
    const rows = (await exec.execute(sql`
      SELECT DISTINCT phone_number
      FROM opt_outs
      WHERE org_id = ${orgId} AND phone_number IN (${inList(chunk)})
    `)) as unknown as { phone_number: string }[];
    for (const r of rows) alreadyOptedOut.add(r.phone_number);
  }
  const survivors = candidatePhones.filter((p) => !alreadyOptedOut.has(p));
  const skipped_already_opted_out = alreadyOptedOut.size;
  if (survivors.length === 0) {
    return { ...empty, skipped_already_opted_out };
  }

  // 3. Upsert contacts + insert opt_outs (created_at = reply time), in chunks.
  //    Track each new opt_out's id/phone/created_at for attribution.
  interface NewOptOut { id: number; phone: string; created_at: string }
  const newOptOuts: NewOptOut[] = [];

  for (let i = 0; i < survivors.length; i += INSERT_CHUNK) {
    const chunk = survivors.slice(i, i + INSERT_CHUNK);
    const contactValues = sql.join(
      chunk.map((p) => sql`(${orgId}::uuid, ${p})`),
      sql`, `,
    );
    const contactRows = (await exec.execute(sql`
      INSERT INTO contacts (org_id, phone_number)
      VALUES ${contactValues}
      ON CONFLICT (org_id, phone_number) DO UPDATE SET updated_at = now()
      RETURNING id, phone_number
    `)) as unknown as { id: string; phone_number: string }[];
    const contactIdByPhone = new Map(contactRows.map((c) => [c.phone_number, c.id]));

    const optOutValues = sql.join(
      chunk.map((p) => {
        const iso = earliestByPhone.get(p)!.toISOString();
        return sql`(${orgId}::uuid, ${contactIdByPhone.get(p)}::uuid, ${p}, ${source}, ${iso}::timestamptz)`;
      }),
      sql`, `,
    );
    const optOutRows = (await exec.execute(sql`
      INSERT INTO opt_outs (org_id, contact_id, phone_number, source, created_at)
      VALUES ${optOutValues}
      RETURNING id, phone_number, created_at
    `)) as unknown as { id: number; phone_number: string; created_at: string }[];
    for (const o of optOutRows)
      newOptOuts.push({ id: o.id, phone: o.phone_number, created_at: o.created_at });

    // Brand + provider junctions for this chunk's opt_outs.
    if (brandIds.length > 0) {
      const bj = optOutRows.flatMap((o) => brandIds.map((bid) => sql`(${o.id}, ${bid})`));
      await exec.execute(sql`
        INSERT INTO opt_out_brands (opt_out_id, brand_id)
        VALUES ${sql.join(bj, sql`, `)}
        ON CONFLICT DO NOTHING
      `);
    }
    if (providerIds.length > 0) {
      const pj = optOutRows.flatMap((o) => providerIds.map((pid) => sql`(${o.id}, ${pid})`));
      await exec.execute(sql`
        INSERT INTO opt_out_providers (opt_out_id, provider_id)
        VALUES ${sql.join(pj, sql`, `)}
        ON CONFLICT DO NOTHING
      `);
    }
  }

  // 4. Contact groups for the survivor contacts (idempotent). The route has
  //    already verified these IDs belong to the org.
  if (args.assignToGroupIds.length > 0) {
    for (let i = 0; i < survivors.length; i += INSERT_CHUNK) {
      const chunk = survivors.slice(i, i + INSERT_CHUNK);
      await exec.execute(sql`
        INSERT INTO contact_contact_groups (contact_id, contact_group_id, org_id)
        SELECT c.id, g.gid, ${orgId}::uuid
        FROM contacts c
        CROSS JOIN (SELECT unnest(ARRAY[${inList(args.assignToGroupIds)}]::int[]) AS gid) g
        WHERE c.org_id = ${orgId} AND c.phone_number IN (${inList(chunk)})
        ON CONFLICT DO NOTHING
      `);
    }
  }

  // 5. Attribute each new opt_out to the single most-recent in-window send.
  let attributed = 0;
  const affected = new Set<number>();
  for (const oo of newOptOuts) {
    const match = await latestSendForAttribution(exec, orgId, oo.phone, oo.created_at);
    if (!match) continue;
    const ins = (await exec.execute(sql`
      INSERT INTO opt_out_attributions
        (org_id, opt_out_id, stage_send_id, stage_id, campaign_id, created_at)
      VALUES (${orgId}, ${oo.id}, ${match.stage_send_id},
              ${match.stage_id}, ${match.campaign_id}, ${oo.created_at}::timestamptz)
      ON CONFLICT (opt_out_id, stage_id) DO NOTHING
      RETURNING id
    `)) as unknown as { id: number }[];
    if (ins.length > 0) {
      attributed++;
      affected.add(match.stage_id);
    }
  }

  // 6. Recompute the affected stages' opt-out counters from the full junction
  //    (idempotent), mirror into opt_out_count, then recompute stage cost — the
  //    same reconciliation the poller / backfill do, scoped to touched stages.
  const affectedStages = [...affected];
  if (affectedStages.length > 0) {
    await exec.execute(sql`
      UPDATE campaign_stages cs
      SET inbound_opt_out_count = agg.n
      FROM (
        SELECT stage_id, count(*)::int AS n
        FROM opt_out_attributions
        WHERE stage_id IN (${inList(affectedStages)})
        GROUP BY stage_id
      ) agg
      WHERE cs.id = agg.stage_id AND cs.inbound_opt_out_count <> agg.n
    `);
    await exec.execute(sql`
      UPDATE campaign_stages cs
      SET opt_out_count = cs.inbound_opt_out_count
      WHERE cs.id IN (${inList(affectedStages)})
        AND cs.inbound_opt_out_count > cs.opt_out_count
    `);
    for (const stageId of affectedStages) {
      await recomputeStageTotalCost(exec, stageId);
    }
  }

  return {
    submitted,
    valid,
    invalid,
    invalid_samples,
    duplicates_in_input,
    duplicates_in_db: 0,
    skipped_already_opted_out,
    inserted: newOptOuts.length,
    attributed,
    unattributed: newOptOuts.length - attributed,
    affected_stages: affectedStages,
  };
}
