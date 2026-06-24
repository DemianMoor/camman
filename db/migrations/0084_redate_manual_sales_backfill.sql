-- Migration 0084: re-date the manual-sales ledger BACKFILL rows to each stage's
-- send/effective day, so historical manual sales attribute to a realistic date.
--
-- Background: migration 0079 seeded one ledger row per stage (delta = the stage's
-- current sales_count) dated to now() — a single "treat as entered now" timestamp.
-- That collapses ALL historical manual sales onto one calendar day, which made the
-- ledger unusable for date-bucketed reporting (every other day reads Keitaro-only).
--
-- Now that sales/revenue reporting is standardized on conversion/entry date
-- (lib/reporting/attribution.ts, ATTRIBUTION_BASIS), manual sales are bucketed by
-- their ledger created_at. We re-date the backfill rows to the stage's EFFECTIVE
-- send day — COALESCE(scheduled_at, sent_at, status_changed_at, created_at), the
-- same expression the dashboard buckets every other stage metric by (see
-- lib/dashboard-stages.ts `stageEffectiveDate`) — so a stage's manual sales land
-- on the same day as its SMS/cost. Real operator entries (entered_by IS NOT NULL)
-- carry a true entry timestamp and are left untouched.
--
-- delta is unchanged, so SUM(delta) per stage still equals campaign_stages
-- .sales_count. Idempotent: re-running re-sets the same value (the source columns
-- don't change) and only ever touches backfill rows.

UPDATE public.stage_manual_sales AS sms
SET created_at = COALESCE(
  cs.scheduled_at,
  cs.sent_at,
  cs.status_changed_at,
  cs.created_at
)
FROM public.campaign_stages AS cs
WHERE cs.id = sms.stage_id
  AND sms.entered_by IS NULL;
