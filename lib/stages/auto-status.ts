import { sql } from "drizzle-orm";

import { logCampaignEvent, type DbOrTx } from "@/lib/campaign-events";

// ── System-driven moves of campaign_stages.status (ClickUp 869evxbgb) ────────
//
// `status` is the operator's record of a stage. The system moves it in exactly
// two places, and only between 'draft' and 'pending':
//   • materialization completes (markMaterialized, lib/sends/kickoff.ts)  draft ⇒ pending
//   • the prepared send is cancelled (…/send/abort)                       pending ⇒ draft
//
// A person always wins. Every manual status write (the status route and
// bulk-status) sets `status_set_manually = true` (migration 0179), and the
// UPDATE refuses any stage carrying it — once an operator has picked a status by
// hand, the system never changes that stage's status again. The `from` match
// makes a repeated or racing call a no-op.
//
// Run autoMoveStageStatus inside the transaction of the event that triggers it,
// so a crash can't leave the status disagreeing with materialized_at. Where that
// event must not depend on the audit insert, log after commit: a failed statement
// inside a postgres.js transaction rolls the whole transaction back, whatever
// logCampaignEvent catches.

export interface AutoStatusMove {
  orgId: string;
  campaignId: number;
  stageId: number;
  from: "draft" | "pending";
  to: "draft" | "pending";
  reason: string;
}

// Returns the moved stage's stage_number, or null when nothing moved.
export async function autoMoveStageStatus(
  dbc: DbOrTx,
  move: AutoStatusMove,
): Promise<number | null> {
  const rows = (await dbc.execute(sql`
    UPDATE campaign_stages
    SET status = ${move.to}, previous_status = status, status_changed_at = now()
    WHERE id = ${move.stageId}
      AND org_id = ${move.orgId}
      AND status = ${move.from}
      AND status_set_manually = false
    RETURNING stage_number
  `)) as unknown as { stage_number: number }[];
  return rows[0]?.stage_number ?? null;
}

export async function logAutoStatusMove(
  dbc: DbOrTx,
  move: AutoStatusMove,
  stageNumber: number,
): Promise<void> {
  await logCampaignEvent(dbc, {
    orgId: move.orgId,
    campaignId: move.campaignId,
    stageId: move.stageId,
    eventType: "stage_status_changed",
    summary: `Stage ${stageNumber} status changed automatically: ${move.from} → ${move.to} (${move.reason})`,
    metadata: {
      from: move.from,
      to: move.to,
      stage_number: stageNumber,
      automatic: true,
    },
  });
}
