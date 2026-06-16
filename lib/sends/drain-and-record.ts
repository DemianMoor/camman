import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { logCampaignEvent } from "@/lib/campaign-events";
import { runStageDrain, type DrainResult, type Sender } from "@/lib/sends/drain";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Run a stage drain AND record its side effects: stamp the stage's fire-lock and
// write the `send_drain` activity event. Shared by the manual "Send now" drain
// route and the collapsed Approve-Send (send-now) path so the bookkeeping can't
// diverge between them.
//
// `runStageDrain` operates purely on `stage_sends`; the caller owns `sent_at` for
// a tracked stage. Once rows were actually attempted (processed > 0) we COALESCE
// in scheduled_at + sent_at (idempotent across re-drains) so there's never a
// window where scheduled_at is set but sent_at is null for the cron to grab, and
// the stage's Scheduled field locks. The audit only fires when something was
// attempted (the */15 cron ticks past idle stages constantly).
export async function runStageDrainAndRecord(
  dbc: DbOrTx,
  opts: {
    campaignId: number;
    stageId: number;
    actorUserId?: string | null;
    sendSms?: Sender;
    isEnabled?: () => boolean;
    isOrgEnabled?: (orgId: string) => Promise<boolean>;
    maxRows?: number;
  },
): Promise<DrainResult> {
  const result = await runStageDrain(dbc, {
    stageId: opts.stageId,
    sendSms: opts.sendSms,
    isEnabled: opts.isEnabled,
    isOrgEnabled: opts.isOrgEnabled,
    maxRows: opts.maxRows,
  });

  if (result.ok && result.processed > 0) {
    const stamp = (await dbc.execute(sql`
      UPDATE campaign_stages
      SET scheduled_at = COALESCE(scheduled_at, now()),
          sent_at = COALESCE(sent_at, now())
      WHERE id = ${opts.stageId}
      RETURNING org_id, stage_number
    `)) as unknown as { org_id: string; stage_number: number }[];

    const orgId = stamp[0]?.org_id;
    if (orgId) {
      const stopped = result.stopReason ? ` · stopped: ${result.stopReason}` : "";
      await logCampaignEvent(dbc, {
        orgId,
        campaignId: opts.campaignId,
        stageId: opts.stageId,
        actorUserId: opts.actorUserId ?? null,
        eventType: "send_drain",
        summary: `Stage ${stamp[0].stage_number} send run: ${result.sent.toLocaleString()} submitted (accepted by TextHub), ${result.failed} failed${stopped}`,
        metadata: {
          sent: result.sent,
          failed: result.failed,
          processed: result.processed,
          remaining: result.remaining,
          stopReason: result.stopReason,
          pausedNow: result.pausedNow,
        },
      });
    }
  }

  return result;
}
