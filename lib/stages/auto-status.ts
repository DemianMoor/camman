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
// bulk-status) sets `status_set_manually = true` (migration 0179), and this
// statement refuses any stage carrying it — once an operator has picked a status
// by hand, the system never changes that stage's status again. The `from` match
// makes a repeated or racing call a no-op.
//
// Call it inside the transaction of the event that triggers it, so a crash can't
// leave the status disagreeing with materialized_at.
export async function autoMoveStageStatus(
  dbc: DbOrTx,
  input: {
    orgId: string;
    campaignId: number;
    stageId: number;
    from: "draft" | "pending";
    to: "draft" | "pending";
    reason: string;
  },
): Promise<boolean> {
  const rows = (await dbc.execute(sql`
    UPDATE campaign_stages
    SET status = ${input.to}, previous_status = status, status_changed_at = now()
    WHERE id = ${input.stageId}
      AND org_id = ${input.orgId}
      AND status = ${input.from}
      AND status_set_manually = false
    RETURNING stage_number
  `)) as unknown as { stage_number: number }[];
  const moved = rows[0];
  if (!moved) return false;

  await logCampaignEvent(dbc, {
    orgId: input.orgId,
    campaignId: input.campaignId,
    stageId: input.stageId,
    eventType: "stage_status_changed",
    summary: `Stage ${moved.stage_number} status changed automatically: ${input.from} → ${input.to} (${input.reason})`,
    metadata: {
      from: input.from,
      to: input.to,
      stage_number: moved.stage_number,
      automatic: true,
    },
  });
  return true;
}
