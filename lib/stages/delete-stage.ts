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

// Hard-delete a stage that holds NO send/result data, of its own OR of any
// behavioral lane hanging off it (parent_stage_id). A never-sent behavioral
// PARENT can have lanes that are the actual send targets (they accumulate
// stage_sends / stage_results_imports / stage_manual_sales /
// keitaro_stage_results); the gate must look at the whole family, not just the
// target row, or the CASCADE from the parent's delete destroys the lanes'
// committed history. A parent whose lanes are all truly empty may still be
// deleted (the "undo an accidental behavioral split" path) — that's why the
// check is on lane DATA, not mere lane existence.
//
// The gate and the delete are done as ONE atomic statement (a self-guarding
// DELETE ... WHERE NOT EXISTS (...)) inside the transaction, so a concurrent
// Prepare can't insert stage_sends in the gap between a separate gate SELECT
// and the DELETE and get its rows cascaded away (TOCTOU).
//
// The DB FKs do the cleanup (ON DELETE CASCADE for stage_sends/links/result
// rows/imports/keitaro/manual sales/opt-out attributions/behavioral lanes;
// SET NULL for campaign_events), so there are no orphans. Factored out of the
// route so it can be tested without an auth session (mirrors
// performBehavioralSplit).
export async function deleteStage(
  opts: { orgId: string; campaignId: number; stageId: number },
  database: typeof db = db,
): Promise<DeleteStageResult> {
  const { orgId, campaignId, stageId } = opts;

  return database.transaction(async (tx) => {
    // Migration 0197: stage_manual_recipients.stage_id is NO ACTION, not
    // cascade — a stage whose export was marked SENT (sent_at set) is refused
    // here, and any other delete path fails on the foreign key instead of
    // erasing the record that those contacts were texted. Rows that were only
    // exported (sent_at NULL) record nothing and are cleared by the `cleared`
    // CTE in this SAME statement, for the stage and its lanes; the NO ACTION
    // check runs at the end of the statement, after that delete.
    let deleted: { stage_number: number; split_total: number | null }[];
    try {
      deleted = (await tx.execute(sql`
      WITH target AS (
        SELECT s.id FROM campaign_stages AS s
        WHERE s.id = ${stageId} AND s.campaign_id = ${campaignId} AND s.org_id = ${orgId}::uuid
          AND s.sent_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM stage_sends ss WHERE ss.stage_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM stage_results_imports ri WHERE ri.stage_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM stage_manual_sales ms WHERE ms.stage_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM keitaro_stage_results kr WHERE kr.stage_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM stage_manual_recipients mr WHERE mr.stage_id = s.id AND mr.sent_at IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM campaign_stages lane
            WHERE lane.parent_stage_id = s.id AND lane.org_id = s.org_id
              AND (lane.sent_at IS NOT NULL
                OR EXISTS (SELECT 1 FROM stage_sends ss2 WHERE ss2.stage_id = lane.id)
                OR EXISTS (SELECT 1 FROM stage_results_imports ri2 WHERE ri2.stage_id = lane.id)
                OR EXISTS (SELECT 1 FROM stage_manual_sales ms2 WHERE ms2.stage_id = lane.id)
                OR EXISTS (SELECT 1 FROM keitaro_stage_results kr2 WHERE kr2.stage_id = lane.id)
                OR EXISTS (SELECT 1 FROM stage_manual_recipients mr2 WHERE mr2.stage_id = lane.id AND mr2.sent_at IS NOT NULL)))
      ),
      cleared AS (
        DELETE FROM stage_manual_recipients mr
        WHERE mr.sent_at IS NULL
          AND mr.stage_id IN (
            SELECT id FROM target
            UNION
            SELECT lane.id FROM campaign_stages lane WHERE lane.parent_stage_id IN (SELECT id FROM target))
      )
      DELETE FROM campaign_stages AS s
      WHERE s.id IN (SELECT id FROM target)
      RETURNING s.stage_number, s.split_total
    `)) as unknown as { stage_number: number; split_total: number | null }[];
    } catch (e) {
      // 23503: a manual-recipients row appeared between the gate and the
      // delete (a concurrent export or mark). The FK refused, nothing was
      // deleted — answer like the gate does.
      if ((e as { cause?: { code?: string } })?.cause?.code === "23503" || (e as { code?: string })?.code === "23503") {
        return {
          ok: false,
          status: 409,
          code: "stage_has_send_data",
          message: "This stage (or one of its behavioral lanes) has send or result data and can't be deleted — archive it instead.",
          details: { reason: "has_send_data" },
        };
      }
      throw e;
    }

    if (deleted.length === 0) {
      // Distinguish 404 (absent) from 409 (gate blocked) with a scoped re-read.
      const existsRows = (await tx.execute(sql`
        SELECT 1 FROM campaign_stages WHERE id = ${stageId} AND campaign_id = ${campaignId} AND org_id = ${orgId}::uuid
      `)) as unknown as unknown[];
      if (existsRows.length === 0) {
        return { ok: false, status: 404, code: "not_found", message: "Stage not found", details: { entity: "stage" } };
      }
      return {
        ok: false,
        status: 409,
        code: "stage_has_send_data",
        message: "This stage (or one of its behavioral lanes) has send or result data and can't be deleted — archive it instead.",
        details: { reason: "has_send_data" },
      };
    }

    const row = deleted[0];
    // If this stage was part of an A/B split and exactly one live split member
    // now remains, revert that survivor to a normal stage.
    let splitResetStageId: number | null = null;
    if (row.split_total !== null) {
      splitResetStageId = await resetLoneSplitSurvivor(tx, { orgId, campaignId });
    }
    return {
      ok: true as const,
      deleted_id: stageId,
      stage_number: row.stage_number,
      split_reset_stage_id: splitResetStageId,
    };
  });
}
