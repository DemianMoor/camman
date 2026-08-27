import { sql, type SQL } from "drizzle-orm";

import type { db } from "@/db/client";

// ── The ONE definition of "this stage has finished sending" ──────────────────
//
// Consumed by:
//   • getParentState() (lib/sends/scheduled.ts) — the P4 parent-complete gate
//   • resolveCompletedStageIds() (lib/stages/split-group.ts) — the campaign-level
//     behavioural split's source set
//
// DO NOT use `campaign_stages.status` for this. That column is the operator's
// MANUAL record of campaign results (see the header of lib/stages/stage-status.ts),
// not the send pipeline. Measured on production 2026-08-27: of 1,231 tracked
// stages, 1,183 have `sent_at` set but only 957 carry a status in
// ('success','sent') — **227 stages really sent while carrying some other
// status**. Filtering the source set on `status` would silently drop all 227.
//
// The pipeline's truth is two facts together:
//   1. `sent_at IS NOT NULL` — Phase B stamps this only after a drain pass
//      actually attempted ≥1 send, so a gate-refused stage never reads "sent".
//   2. no non-terminal rows left. 'pending'/'sending' block; 'failed' and the
//      'skipped_*' buckets are terminal and do NOT block — one failed number
//      must never keep a stage from counting as finished (and the lane aliveness
//      filter matches on status='sent' only anyway).
//
// `alias` is the SQL identifier of the campaign_stages row in the caller's query.
export function stageCompleteExpr(alias = "s"): SQL {
  const a = sql.raw(alias);
  return sql`(
    ${a}.sent_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM stage_sends ss
      WHERE ss.stage_id = ${a}.id AND ss.status IN ('pending', 'sending')
    )
  )`;
}

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Every COMPLETED, non-archived stage of one campaign, as a `SELECT id` set.
// Lanes are excluded: a lane's own recipients are a subset of the source stages
// it was drawn from, so including them would be redundant, and a lane of an
// EARLIER split would drag its own narrower universe into a later split's source.
export function completedStageIdsSql(campaignId: number, orgId: string): SQL {
  return sql`
    SELECT s.id
    FROM campaign_stages s
    WHERE s.campaign_id = ${campaignId}::int
      AND s.org_id = ${orgId}::uuid
      AND s.archived_at IS NULL
      AND s.behavioral_tier IS NULL
      AND ${stageCompleteExpr("s")}
  `;
}

// Materialized list form, for the split's source-set resolution and the
// "≥1 completed stage" UI gate. Ordered by sent_at so callers can take the last
// element as the P4 slip anchor without a second query.
export async function resolveCompletedStages(
  dbc: DbOrTx,
  campaignId: number,
  orgId: string,
): Promise<{ id: number; stage_number: number; label: string | null; sent_at: string }[]> {
  return (await dbc.execute(sql`
    SELECT s.id, s.stage_number, s.label, s.sent_at
    FROM campaign_stages s
    WHERE s.campaign_id = ${campaignId}::int
      AND s.org_id = ${orgId}::uuid
      AND s.archived_at IS NULL
      AND s.behavioral_tier IS NULL
      AND ${stageCompleteExpr("s")}
    ORDER BY s.sent_at ASC, s.id ASC
  `)) as unknown as {
    id: number;
    stage_number: number;
    label: string | null;
    sent_at: string;
  }[];
}
