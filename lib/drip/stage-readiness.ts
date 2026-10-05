// "Will this drip stage send?" — one definition, used by the UI badge.
//
// ⭐ THIS MIRRORS lib/drip/scheduler.ts AND NOTHING ELSE. The scheduler decides
// what actually sends; this answers the same question for an operator looking at
// the stages list. A second, independently-written status is how a screen comes
// to disagree with the worker — and the whole reason this file exists is that
// the list was already showing one: `campaign_stages.status` (Draft / Send-Draft)
// is the REGULAR lifecycle and takes no part in drip sending at all.
//
// The scheduler's conditions, in the order it applies them:
//
//   org_settings.drip_enabled = true AND drip_paused = false   (posture)
//   campaigns.type = 'drip' AND campaigns.status = 'active'
//   campaigns.send_paused IS NOT TRUE                          (skipped at run)
//   campaign_stages.drip_active IS TRUE
//   campaign_stages.archived_at IS NULL
//   both window_start_min and window_end_min are integers      (pickStage
//     filters non-integers out, so a stage without a full window can never be
//     chosen for any arrival)
//
// ⚠️ `campaign_stages.status` IS DELIBERATELY ABSENT. A drip stage sits at
// 'draft' for ever — nothing promotes it, because a drip stage is never
// materialized or approved the way a regular one is. Reading it as a send gate
// is what made the list unreadable.

export interface DripStageReadinessInput {
  /** org_settings.drip_enabled */
  postureEnabled: boolean;
  /** org_settings.drip_paused */
  posturePaused: boolean;
  /** campaigns.status */
  campaignStatus: string | null | undefined;
  /** campaigns.send_paused */
  campaignPaused: boolean | null | undefined;
  /** campaign_stages.drip_active */
  stageActive: boolean | null | undefined;
  /** campaign_stages.archived_at */
  stageArchived: boolean;
  windowStartMin: number | null | undefined;
  windowEndMin: number | null | undefined;
}

export type DripStageBlocker =
  | "posture_off"
  | "posture_paused"
  | "campaign_not_active"
  | "campaign_paused"
  | "stage_archived"
  | "stage_inactive"
  | "no_window";

export interface DripStageReadiness {
  willSend: boolean;
  /** Every unmet condition, most-global first — not just the first one. */
  blockers: DripStageBlocker[];
  /** Short label for the badge. */
  label: string;
}

const LABELS: Record<DripStageBlocker, string> = {
  posture_off: "Drip off",
  posture_paused: "Drip paused",
  campaign_not_active: "Campaign not active",
  campaign_paused: "Campaign paused",
  stage_archived: "Archived",
  stage_inactive: "Inactive",
  no_window: "No window",
};

export function dripStageReadiness(i: DripStageReadinessInput): DripStageReadiness {
  const blockers: DripStageBlocker[] = [];

  // Ordered outermost-first so the badge names the thing an operator should fix
  // first: a stage toggled on inside a paused campaign is not "Active".
  if (!i.postureEnabled) blockers.push("posture_off");
  if (i.posturePaused) blockers.push("posture_paused");
  if (i.campaignStatus !== "active") blockers.push("campaign_not_active");
  if (i.campaignPaused === true) blockers.push("campaign_paused");
  if (i.stageArchived) blockers.push("stage_archived");
  if (i.stageActive !== true) blockers.push("stage_inactive");
  // Both ends required — pickStage drops a stage whose window is not two
  // integers, so a half-set window is as unsendable as none.
  if (!Number.isInteger(i.windowStartMin) || !Number.isInteger(i.windowEndMin)) {
    blockers.push("no_window");
  }

  return {
    willSend: blockers.length === 0,
    blockers,
    label: blockers.length === 0 ? "Will send" : LABELS[blockers[0]],
  };
}
