import { sql, type SQL } from "drizzle-orm";

import { ENGAGEMENT_STATUSES, type EngagementStatus } from "@/lib/engagement/constants";
import { evaluationSelectSql } from "@/lib/engagement/status-sql";
import {
  createThresholdTempTables,
  type ThresholdSourceOptions,
} from "@/lib/engagement/thresholds-sql";
import type { DbOrTx } from "@/lib/reporting/cron-heartbeat";

// =============================================================================
// "WHAT WOULD THIS THRESHOLD CHANGE DO?" (spec §6)
//
// The same evaluator the job uses, run over the STORED facts in
// contact_engagement with the proposed thresholds injected. It does NOT recount
// stage_sends — that is the backfill's two-minute pass, and the answer does not
// need it: thresholds move contacts between statuses given the facts as they
// are, and the facts are already stored.
//
// Contacts with NO contact_engagement row are deliberately not evaluated: they
// are `new` with zero messages, and no threshold can change that.
//
// Writes nothing. The caller owns the transaction (temp tables).
// =============================================================================

export interface LifecyclePreviewResult {
  evaluated: number;
  currentCounts: Record<EngagementStatus, number>;
  projectedCounts: Record<EngagementStatus, number>;
  /** Only the rows that would MOVE, keyed "cold→freeze". */
  transitions: Record<string, number>;
  durationMs: number;
}

const zero = (): Record<EngagementStatus, number> =>
  Object.fromEntries(ENGAGEMENT_STATUSES.map((s) => [s, 0])) as Record<EngagementStatus, number>;

export async function previewLifecycleThresholds(
  dbc: DbOrTx,
  orgId: string,
  opts: ThresholdSourceOptions & { asOf?: Date },
): Promise<LifecyclePreviewResult> {
  const started = Date.now();
  const org = sql`${orgId}::uuid`;
  const asOf: SQL = opts.asOf ? sql`${opts.asOf.toISOString()}::timestamptz` : sql`now()`;
  await createThresholdTempTables(dbc, orgId, opts);

  // The evaluator's input columns, sourced from the stored row. What the
  // evaluator calls calc_freeze_* is simply what is stored: no recount happened,
  // so nothing new was sent while this preview ran.
  const input = sql`(
    SELECT ce.contact_id,
           ce.status AS prev_status,
           ce.status_changed_at AS prev_status_changed_at,
           ce.freeze_entered_at AS prev_freeze_entered_at,
           ce.msgs_total, ce.msgs_since_click, ce.msgs_7d, ce.msgs_14d, ce.msgs_30d, ce.msgs_90d,
           ce.first_sent_at, ce.last_sent_at, ce.first_click_at, ce.last_click_at,
           ce.freeze_started_at AS calc_freeze_started_at,
           ce.freeze_msgs AS calc_freeze_msgs,
           o.hot_days, o.warm_days,
           coalesce(g.freeze_after_messages, o.freeze_after_messages) AS freeze_after_messages,
           coalesce(g.freeze_cadence_days, o.freeze_cadence_days) AS freeze_cadence_days,
           coalesce(g.suppress_after_days, o.suppress_after_days) AS suppress_after_days,
           coalesce(g.suppress_min_freeze_messages, o.suppress_min_freeze_messages) AS suppress_min_freeze_messages,
           coalesce(g.override_group_ids, '{}'::int[]) AS override_group_ids
    FROM contact_engagement ce
    LEFT JOIN eng_grp_thr g ON g.contact_id = ce.contact_id
    CROSS JOIN eng_org_thr o
    WHERE ce.org_id = ${org}
  )`;

  const rows = (await dbc.execute(sql`
    SELECT prev_status, status, count(*)::int AS n
    FROM (${evaluationSelectSql(input, asOf, "first_seen")}) p
    GROUP BY 1, 2
  `)) as unknown as { prev_status: EngagementStatus; status: EngagementStatus; n: number }[];

  const currentCounts = zero();
  const projectedCounts = zero();
  const transitions: Record<string, number> = {};
  let evaluated = 0;
  for (const r of rows) {
    const n = Number(r.n);
    evaluated += n;
    currentCounts[r.prev_status] += n;
    projectedCounts[r.status] += n;
    if (r.prev_status !== r.status) transitions[`${r.prev_status}→${r.status}`] = n;
  }
  return { evaluated, currentCounts, projectedCounts, transitions, durationMs: Date.now() - started };
}
