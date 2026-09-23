// Contact lifecycle status — constants shared by the job, the settings UI (PR 2)
// and the tests. Spec: docs/superpowers/specs/2026-09-22-contact-lifecycle-status-design.md.
// The code says "engagement" because lib/drip/lifecycle.ts already means the
// drip-journey lifecycle, and opt_outs.reason 'suppressed' already means Global
// Suppression. The user-facing label is still "Suppressed".

export const ENGAGEMENT_STATUSES = ["new", "cold", "hot", "warm", "freeze", "suppressed"] as const;
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

// Mirrors contact_engagement_transitions_reason_check (migration 0187).
export const TRANSITION_REASONS = [
  "backfill",
  "first_seen",
  "first_message",
  "freeze_threshold",
  "threshold_change",
  "freeze_expired",
  "human_click",
  "click_aged_warm",
  "click_aged_cold",
  "recount",
] as const;
export type TransitionReason = (typeof TRANSITION_REASONS)[number];

export interface LifecycleThresholds {
  hot_days: number;
  warm_days: number;
  freeze_after_messages: number;
  freeze_cadence_days: number;
  suppress_after_days: number;
  suppress_min_freeze_messages: number;
}

/**
 * Org defaults used when an org has no lifecycle_settings row. These MUST equal
 * the column DEFAULTs in migration 0187 — the row and the fallback are two
 * spellings of the same policy.
 */
export const DEFAULT_LIFECYCLE_THRESHOLDS: LifecycleThresholds = {
  hot_days: 30,
  warm_days: 120,
  freeze_after_messages: 10,
  freeze_cadence_days: 14,
  suppress_after_days: 60,
  suppress_min_freeze_messages: 2,
};

// cron_locks rows. The lease and the heartbeats are separate rows, as in
// lib/reporting/delivery-rollup.ts: a lease row's watermark is not a heartbeat.
export const ENGAGEMENT_LEASE = "contact-engagement-run";
export const ENGAGEMENT_JOB = "contact-engagement"; // heartbeat: any successful run
export const ENGAGEMENT_FULL_JOB = "contact-engagement-full"; // heartbeat: a successful full recount
/** cron_locks watermark: the last run that evaluated EVERY stored row (a full recount, or one honouring a threshold change). */
export const ENGAGEMENT_REEVAL_JOB = "contact-engagement-reeval";

/**
 * An incremental run re-reads sends and clicks from this long before the last
 * success. Recounts read a contact's FULL history, so overlap costs nothing and
 * covers a send that committed just after the previous run read its window.
 */
export const INCREMENTAL_OVERLAP_MINUTES = 30;

/**
 * If the last successful run is older than this, the next run recounts
 * everything. Kept SHORT on purpose: `since` only advances on success, so a
 * failed run makes the next window wider, which makes failure likelier. Three
 * hours bounds that spiral — measured 2026-09-23, when a send burst put 43,448
 * contacts in one window, the per-contact recount blew the statement timeout,
 * and the job stalled for 2.5 h until a full recount was run by hand.
 */
export const FULL_FALLBACK_HOURS = 3;

/**
 * Above this many touched contacts, an incremental run ESCALATES to a full
 * recount. The incremental path costs one index probe per touched contact,
 * which is the right shape for a normal 15-minute window (tens to hundreds)
 * and the wrong shape for a send burst: at 43,448 contacts it exceeded the
 * statement timeout, while the org-wide set-based pass finishes in ~230 s for
 * every contact there is. Past this point the bounded pass is the cheaper one.
 */
export const INCREMENTAL_MAX_TOUCHED = 20_000;
