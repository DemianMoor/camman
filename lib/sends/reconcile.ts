import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import type { StageRecipientFilters } from "@/lib/sends/recipients";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Stage send reconciliation (Workstream 3, Guarantee 1): prove no recipient
// silently vanished. The frozen campaign pool partitions exactly into
//   pool = attempted + excluded(opt_out | filter | split) + gap
// where `attempted` = materialized stage_sends rows and `gap` is the part that
// is NEITHER an attempt NOR a logged exclusion — i.e. OUR bug, surfaced loudly
// rather than hidden in count math.
//
// The qualification predicate MUST mirror stageRecipientsSql in
// [lib/sends/recipients.ts] — that is the single source the kickoff materializes
// from. If the two diverge, the divergence itself shows up as a non-zero gap.
export interface StageReconciliation {
  pool_total: number;
  qualified: number; // pool members that pass suppression + filter + split
  attempted: number; // stage_sends rows actually materialized
  excluded_optout: number;
  excluded_filter: number;
  excluded_split: number;
  excluded_total: number;
  gap: number; // qualified - attempted; 0 ⇒ closed. >0 ⇒ a materialization drop
  closed: boolean; // gap === 0
}

export async function computeStageReconciliation(
  dbc: DbOrTx,
  opts: {
    campaignId: number;
    orgId: string;
    stageId: number;
    filters: StageRecipientFilters;
  },
): Promise<StageReconciliation> {
  const { campaignId, orgId, stageId, filters: f } = opts;
  const splitActive = f.splitIndex !== null && f.splitTotal !== null;

  // Single pass over the frozen pool, attributing each member to exactly one
  // bucket by priority: opted-out > fails-filter > out-of-split > qualified.
  const rows = (await dbc.execute(sql`
    WITH pool AS (
      SELECT
        p.contact_id,
        EXISTS (
          SELECT 1 FROM opt_outs oo
          WHERE oo.contact_id = p.contact_id AND oo.org_id = ${orgId}::uuid
        ) AS opted_out,
        (
          ((${f.includeNoStatus}::boolean AND p.was_no_status_at_snapshot)
            OR (${f.includeClickers}::boolean AND p.was_clicker_at_snapshot))
          AND NOT (${f.excludeClickers}::boolean AND p.was_clicker_at_snapshot)
        ) AS passes_filter,
        CASE
          WHEN ${splitActive}::boolean
            THEN (row_number() OVER (ORDER BY p.contact_id) - 1)
                 % ${f.splitTotal ?? 1}::int = (${(f.splitIndex ?? 1) - 1})::int
          ELSE true
        END AS in_split
      FROM campaign_audience_pool p
      WHERE p.campaign_id = ${campaignId}::int AND p.org_id = ${orgId}::uuid
    )
    SELECT
      count(*)::int AS pool_total,
      count(*) FILTER (WHERE opted_out)::int AS excluded_optout,
      count(*) FILTER (WHERE NOT opted_out AND NOT passes_filter)::int AS excluded_filter,
      count(*) FILTER (WHERE NOT opted_out AND passes_filter AND NOT in_split)::int AS excluded_split,
      count(*) FILTER (WHERE NOT opted_out AND passes_filter AND in_split)::int AS qualified
    FROM pool
  `)) as unknown as {
    pool_total: number;
    excluded_optout: number;
    excluded_filter: number;
    excluded_split: number;
    qualified: number;
  }[];

  const attemptedRows = (await dbc.execute(sql`
    SELECT count(*)::int AS attempted FROM stage_sends
    WHERE stage_id = ${stageId} AND org_id = ${orgId}::uuid
  `)) as unknown as { attempted: number }[];

  const r = rows[0] ?? {
    pool_total: 0,
    excluded_optout: 0,
    excluded_filter: 0,
    excluded_split: 0,
    qualified: 0,
  };
  const attempted = Number(attemptedRows[0]?.attempted ?? 0);
  const excluded_total =
    Number(r.excluded_optout) + Number(r.excluded_filter) + Number(r.excluded_split);
  const qualified = Number(r.qualified);
  const gap = qualified - attempted;

  return {
    pool_total: Number(r.pool_total),
    qualified,
    attempted,
    excluded_optout: Number(r.excluded_optout),
    excluded_filter: Number(r.excluded_filter),
    excluded_split: Number(r.excluded_split),
    excluded_total,
    gap,
    closed: gap === 0,
  };
}
