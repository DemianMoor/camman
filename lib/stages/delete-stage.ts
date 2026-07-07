import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { resetLoneSplitSurvivor } from "@/lib/stages/split-membership";

export type DeleteStageResult =
  | {
      ok: true;
      deleted_id: number;
      stage_number: number;
      split_reset_stage_id: number | null;
    }
  | { ok: false; status: number; code: string; message: string; details?: unknown };

// Hard-delete a stage that holds NO send/result data. The DB FKs do the cleanup
// (ON DELETE CASCADE for stage_sends/links/result rows/imports/keitaro/manual
// sales/opt-out attributions/behavioral lanes; SET NULL for campaign_events),
// so there are no orphans. Factored out of the route so it can be tested without
// an auth session (mirrors performBehavioralSplit).
export async function deleteStage(
  opts: { orgId: string; campaignId: number; stageId: number },
  database: typeof db = db,
): Promise<DeleteStageResult> {
  const { orgId, campaignId, stageId } = opts;

  // Load the stage AND whether it carries any real send/result data, one trip.
  // These four tables cover everything: links/stage_result_rows/opt_out_
  // attributions only ever exist alongside one of them.
  const rows = (await database.execute(sql`
    SELECT s.id, s.stage_number, s.split_total,
      (s.sent_at IS NOT NULL
        OR EXISTS (SELECT 1 FROM stage_sends ss WHERE ss.stage_id = s.id)
        OR EXISTS (SELECT 1 FROM stage_results_imports ri WHERE ri.stage_id = s.id)
        OR EXISTS (SELECT 1 FROM stage_manual_sales ms WHERE ms.stage_id = s.id)
        OR EXISTS (SELECT 1 FROM keitaro_stage_results kr WHERE kr.stage_id = s.id)
      ) AS has_send_data
    FROM campaign_stages s
    WHERE s.id = ${stageId} AND s.campaign_id = ${campaignId} AND s.org_id = ${orgId}::uuid
    LIMIT 1
  `)) as unknown as {
    id: number;
    stage_number: number;
    split_total: number | null;
    has_send_data: boolean;
  }[];

  const stage = rows[0];
  if (!stage) {
    return { ok: false, status: 404, code: "not_found", message: "Stage not found", details: { entity: "stage" } };
  }
  if (stage.has_send_data) {
    return {
      ok: false,
      status: 409,
      code: "stage_has_send_data",
      message: "This stage has send or result data and can't be deleted — archive it instead.",
      details: { reason: "has_send_data" },
    };
  }

  return database.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM campaign_stages
      WHERE id = ${stageId} AND campaign_id = ${campaignId} AND org_id = ${orgId}::uuid
    `);
    // If this stage was part of an A/B split and exactly one live split member
    // now remains, revert that survivor to a normal stage.
    let splitResetStageId: number | null = null;
    if (stage.split_total !== null) {
      splitResetStageId = await resetLoneSplitSurvivor(tx, { orgId, campaignId });
    }
    return {
      ok: true as const,
      deleted_id: stageId,
      stage_number: stage.stage_number,
      split_reset_stage_id: splitResetStageId,
    };
  });
}
