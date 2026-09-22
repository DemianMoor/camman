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

/**
 * An incremental run re-reads sends and clicks from this long before the last
 * success. Recounts read a contact's FULL history, so overlap costs nothing and
 * covers a send that committed just after the previous run read its window.
 */
export const INCREMENTAL_OVERLAP_MINUTES = 30;

/** If the last successful run is older than this, the next run recounts everything. */
export const FULL_FALLBACK_HOURS = 24;
