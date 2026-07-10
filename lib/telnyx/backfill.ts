import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

import { telnyxBalance } from "./client";
import { estimateLookupCost, DEFAULT_MOBILE_SHARE } from "./cost";
import { enqueueNormalized, type EnqueueResult } from "./enqueue";
import { loadLookupSettings } from "./settings";

export interface BackfillPreview {
  distinct_phones_needing: number; // distinct non-archived phones with no lookup row
  contact_count: number; // non-archived contacts in scope
  archived_excluded: number; // archived contacts skipped
  sample_limit: number | null; // if set, only this many (random) will run
  to_run: number; // min(needing, sample_limit)
  est_cost_usd: number;
  balance_usd: number | null;
  balance_error: string | null;
  daily_cap: number;
  eta_days: number; // ceil(to_run / daily_cap)
}

// Distinct non-archived phones of this org that have no phone_lookups row yet.
// (Archived contacts are excluded — paying to look up numbers you've archived is
// waste.) A phone shared by multiple contacts counts once.
function needingCountSql(orgId: string) {
  return sql`
    SELECT count(*)::text AS n FROM (
      SELECT DISTINCT c.phone_number
      FROM contacts c
      WHERE c.org_id = ${orgId}::uuid
        AND c.is_archived = false
        AND NOT EXISTS (SELECT 1 FROM phone_lookups pl WHERE pl.phone = c.phone_number)
    ) d`;
}

export async function previewBackfill(
  orgId: string,
  sampleLimit: number | null,
): Promise<BackfillPreview> {
  const needingRows = await db.execute<{ n: string }>(needingCountSql(orgId));
  const distinct_phones_needing = Number(needingRows[0]?.n ?? 0);

  const counts = await db.execute<{ active: string; archived: string }>(sql`
    SELECT
      count(*) FILTER (WHERE is_archived = false)::text AS active,
      count(*) FILTER (WHERE is_archived = true)::text AS archived
    FROM contacts WHERE org_id = ${orgId}::uuid`);
  const contact_count = Number(counts[0]?.active ?? 0);
  const archived_excluded = Number(counts[0]?.archived ?? 0);

  const to_run =
    sampleLimit != null
      ? Math.min(sampleLimit, distinct_phones_needing)
      : distinct_phones_needing;

  const settings = await loadLookupSettings();
  const est_cost_usd = estimateLookupCost(
    to_run,
    { base: settings.lookup_rate_base, mobile: settings.lookup_rate_mobile },
    DEFAULT_MOBILE_SHARE,
  );
  const bal = await telnyxBalance();
  const daily_cap = settings.lookup_daily_cap;
  const eta_days = daily_cap > 0 ? Math.ceil(to_run / daily_cap) : 0;

  return {
    distinct_phones_needing,
    contact_count,
    archived_excluded,
    sample_limit: sampleLimit,
    to_run,
    est_cost_usd,
    balance_usd: bal.ok ? bal.availableCredit : null,
    balance_error: bal.ok ? null : bal.error,
    daily_cap,
    eta_days,
  };
}

// Kick a backfill batch. Selects distinct non-archived phones lacking a lookup;
// when sampleLimit is set, RANDOMLY samples that many (ORDER BY random()) — NOT
// first-N — so a partial run (e.g. the 500-number calibration) is representative
// of the whole base. Then enqueues via the normal path (trigger='backfill').
export async function runBackfill(
  orgId: string,
  sampleLimit: number | null,
): Promise<EnqueueResult> {
  // ORDER BY random() must sit OUTSIDE the DISTINCT (Postgres rejects a DISTINCT +
  // ORDER BY expr not in the select list), so subquery the distinct set first.
  const limitClause =
    sampleLimit != null ? sql`ORDER BY random() LIMIT ${sampleLimit}` : sql``;
  const rows = await db.execute<{ phone_number: string }>(sql`
    SELECT phone_number FROM (
      SELECT DISTINCT c.phone_number
      FROM contacts c
      WHERE c.org_id = ${orgId}::uuid
        AND c.is_archived = false
        AND NOT EXISTS (SELECT 1 FROM phone_lookups pl WHERE pl.phone = c.phone_number)
    ) d
    ${limitClause}
  `);
  const phones = rows.map((r) => r.phone_number);
  return enqueueNormalized(orgId, phones, "backfill");
}
