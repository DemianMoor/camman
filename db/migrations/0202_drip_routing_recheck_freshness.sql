-- 0202: drip routing — permanent/temporary rejections + freshness (card 869ency4b items 1-3).
-- Additive only. Leads the code that reads these columns.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- A deferred lead (only TEMPORARY blockers) is not re-evaluated before this time.
ALTER TABLE "lead_events" ADD COLUMN IF NOT EXISTS "drip_recheck_at" timestamp with time zone;--> statement-breakpoint
-- The routing worker's candidate scan: one ET day of non-sandbox leads.
-- lead_events is ~90K rows / 34 MB, so a plain (non-concurrent) build is sub-second.
CREATE INDEX IF NOT EXISTS "lead_events_drip_candidates_idx"
  ON "lead_events" USING btree ("org_id", "received_at") WHERE "sandbox" = false;--> statement-breakpoint
-- Freshness: drip admission closes this many minutes after the end of the lead's
-- arrival ET day. Org default 0 (midnight ET); per-campaign override, NULL = default.
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "drip_admission_cutoff_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_drip_admission_cutoff_check";--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_drip_admission_cutoff_check"
  CHECK ("drip_admission_cutoff_minutes" >= 0);--> statement-breakpoint
ALTER TABLE "drip_campaign_configs" ADD COLUMN IF NOT EXISTS "admission_cutoff_minutes" integer;--> statement-breakpoint
ALTER TABLE "drip_campaign_configs" DROP CONSTRAINT IF EXISTS "drip_campaign_configs_admission_cutoff_check";--> statement-breakpoint
ALTER TABLE "drip_campaign_configs" ADD CONSTRAINT "drip_campaign_configs_admission_cutoff_check"
  CHECK ("admission_cutoff_minutes" IS NULL OR "admission_cutoff_minutes" >= 0);
