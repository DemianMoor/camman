-- 0207: drip scheduler per-campaign fairness. Additive only; ships dark.
--   org_settings.drip_scheduler_fair — when on, runDripSchedulerBatch fills its
--   batch round-robin across campaigns (each campaign's oldest journey, then
--   the next, …) instead of the org-wide oldest first, so one campaign's
--   backlog cannot starve another campaign's fresh leads. Off (default) = the
--   old order exactly. Rollback = set false.
-- Re-runnable: ADD COLUMN IF NOT EXISTS. Constant default: no rewrite.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS drip_scheduler_fair boolean NOT NULL DEFAULT false;--> statement-breakpoint
COMMENT ON COLUMN public.org_settings.drip_scheduler_fair IS
  'Drip scheduler per-campaign fairness (0207): the first-send batch is filled round-robin across campaigns. Off = org-wide oldest first.';
