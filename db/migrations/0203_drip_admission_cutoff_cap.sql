-- 0203: drip freshness cutoff is minutes past midnight ET, at most 1439.
-- 0202 allowed any value >= 0 (the API allowed up to 10080). A cutoff of a day
-- or more moves the routing worker's candidate floor back past already-skipped
-- leads and admits them again (~72K on 2026-10-12: the Oct-10 backlog plus the
-- Oct-11 expiries). Multi-day carry-over will be its own guarded setting.
-- Every live value is NULL or 0, so the tightened CHECKs validate instantly.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_drip_admission_cutoff_check";--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_drip_admission_cutoff_check"
  CHECK ("drip_admission_cutoff_minutes" >= 0 AND "drip_admission_cutoff_minutes" <= 1439);--> statement-breakpoint
ALTER TABLE "drip_campaign_configs" DROP CONSTRAINT IF EXISTS "drip_campaign_configs_admission_cutoff_check";--> statement-breakpoint
ALTER TABLE "drip_campaign_configs" ADD CONSTRAINT "drip_campaign_configs_admission_cutoff_check"
  CHECK ("admission_cutoff_minutes" IS NULL OR ("admission_cutoff_minutes" >= 0 AND "admission_cutoff_minutes" <= 1439));
