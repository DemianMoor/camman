-- 0209: drip hourly send cap (spec 2026-10-13). Additive only; ships dark.
--   drip_campaign_configs.hourly_cap   — first sends per ET clock hour; NULL = no limit.
--   drip_campaign_configs.hourly_carry — unsent leads queue into later hours (true)
--                                        or are dropped at hour end (false, default).
--   drip_journeys.hour_start/hour_fresh — the clock hour a lead is on; NULL = waiting.
--   org_settings.drip_hourly_cap_enabled — kill switch; false = every hourly setting ignored.
-- Re-runnable. Constant defaults: no rewrite. ADD CONSTRAINT ... CHECK scans
-- drip_journeys under ACCESS EXCLUSIVE, held for the rest of the migration transaction
-- (including the three index builds). At current table size that is seconds, and it blocks
-- routing/scheduler writes while it runs.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE public.drip_campaign_configs
  ADD COLUMN IF NOT EXISTS hourly_cap integer,
  ADD COLUMN IF NOT EXISTS hourly_carry boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE public.drip_campaign_configs DROP CONSTRAINT IF EXISTS drip_campaign_configs_hourly_cap_check;--> statement-breakpoint
ALTER TABLE public.drip_campaign_configs
  ADD CONSTRAINT drip_campaign_configs_hourly_cap_check CHECK (hourly_cap IS NULL OR hourly_cap > 0);--> statement-breakpoint
ALTER TABLE public.drip_journeys
  ADD COLUMN IF NOT EXISTS hour_start timestamptz,
  ADD COLUMN IF NOT EXISTS hour_fresh boolean;--> statement-breakpoint
ALTER TABLE public.drip_journeys DROP CONSTRAINT IF EXISTS drip_journeys_hour_pair_check;--> statement-breakpoint
ALTER TABLE public.drip_journeys
  ADD CONSTRAINT drip_journeys_hour_pair_check CHECK ((hour_start IS NULL) = (hour_fresh IS NULL));--> statement-breakpoint
ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS drip_hourly_cap_enabled boolean NOT NULL DEFAULT false;--> statement-breakpoint
-- Hourly sent count. No state filter: a journey that opts out inside the hour still counts.
CREATE INDEX IF NOT EXISTS drip_journeys_campaign_first_send_idx
  ON public.drip_journeys (campaign_id, first_send_at) WHERE first_send_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS drip_journeys_hourly_queue_idx
  ON public.drip_journeys (campaign_id, hour_start, routed_at) WHERE state = 'routed' AND first_send_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS drip_journeys_missed_hour_idx
  ON public.drip_journeys (campaign_id, closed_at) WHERE close_reason LIKE 'missed_hour%';--> statement-breakpoint
COMMENT ON COLUMN public.drip_journeys.hour_start IS
  'Hourly cap (0209): UTC instant of the ET clock hour this unsent lead is on. NULL = waiting (outside a window, or reverted by a stop control).';--> statement-breakpoint
COMMENT ON COLUMN public.drip_journeys.hour_fresh IS
  'Hourly cap (0209): true = assigned by its own routing hour; false = released backlog (never dropped by the hourly rule).';--> statement-breakpoint
COMMENT ON COLUMN public.org_settings.drip_hourly_cap_enabled IS
  'Hourly cap kill switch (0209). false = the scheduler ignores every hourly setting and clears assignments.';
