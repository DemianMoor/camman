import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { MAX_FIRST_SEND_STAGES, validateWindowSet, type StageWindow } from "@/lib/drip/windows";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Server-side guard for drip stage windows (Drip Phase 5).
//
// ⚠️ WHY THIS EXISTS SEPARATELY FROM THE DB CHECK. `campaign_stages` carries a
// CHECK for the SINGLE-ROW half (end after start, both inside the day). The rule
// that matters most — windows may not overlap **or touch** — spans MULTIPLE ROWS
// and therefore cannot be a CHECK constraint at all. This is where it lives.
//
// ⚠️ AND IT CALLS THE SAME FUNCTION THE EDITOR CALLS. `validateWindowSet` is
// shared with components/campaigns/drip-stage-window-fields.tsx. A server-only
// re-implementation would drift from the client's, and the operator would meet
// the real rule for the first time as a save failure worded differently from the
// warning they were reading a second earlier.
//
// The touching case is the one that actually bites: 09:30–14:00 followed by
// 14:00–18:30 looks correct and means the minute 14:00 belongs to two stages, so
// "exactly ONE first-send" has no answer for a lead arriving then.

export interface WindowGuardRefusal {
  message: string;
  field: string;
}

/**
 * Returns null when the proposed window is allowed.
 *
 * `excludeStageId` is the stage being edited — it must not be compared against
 * itself, or every edit that leaves the window unchanged would report an overlap
 * with the value already stored.
 */
export async function checkDripStageWindow(
  dbc: DbOrTx,
  {
    orgId,
    campaignId,
    excludeStageId,
    windowStartMin,
    windowEndMin,
    dripActive,
  }: {
    orgId: string;
    campaignId: number;
    excludeStageId?: number | null;
    windowStartMin: number | null | undefined;
    windowEndMin: number | null | undefined;
    dripActive: boolean | null | undefined;
  },
): Promise<WindowGuardRefusal | null> {
  // Nothing proposed ⇒ a regular stage. Nothing to check.
  if (windowStartMin == null && windowEndMin == null) return null;
  if (windowStartMin == null || windowEndMin == null) {
    return {
      message: "A drip stage needs both an opening and a closing time.",
      field: "window_start_min",
    };
  }

  const siblings = (await dbc.execute(sql`
    SELECT id AS stage_id, window_start_min, window_end_min
    FROM campaign_stages
    WHERE campaign_id = ${campaignId}
      AND org_id = ${orgId}::uuid
      AND archived_at IS NULL
      AND drip_active IS TRUE
      AND window_start_min IS NOT NULL
      AND window_end_min IS NOT NULL
      ${excludeStageId != null ? sql`AND id <> ${excludeStageId}` : sql``}
  `)) as unknown as StageWindow[];

  // ⚠️ An INACTIVE stage is not compared. Two stages may hold the same window as
  // long as only one is active — that is how an operator swaps a window over
  // without a gap. The scheduler only ever reads active stages.
  const proposed: StageWindow[] = [
    { stage_id: excludeStageId ?? -1, window_start_min: windowStartMin, window_end_min: windowEndMin },
  ];
  const all = dripActive === true ? [...siblings, ...proposed] : proposed;

  const problems = validateWindowSet(all);
  if (problems.length === 0) {
    // The count rule applies to ACTIVE first-send stages.
    if (dripActive === true && siblings.length + 1 > MAX_FIRST_SEND_STAGES) {
      return {
        message: `A drip campaign may have at most ${MAX_FIRST_SEND_STAGES} active first-send stages.`,
        field: "drip_active",
      };
    }
    return null;
  }

  // Report every problem, not just the first — an operator fixing a set of
  // windows should see the whole picture rather than discovering one per save.
  return {
    message: problems.map((p) => p.message).join(" "),
    field: "window_start_min",
  };
}
