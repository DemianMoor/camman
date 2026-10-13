-- 0210: drip routing send capacity (capacity overflow). Additive only; ships dark.
--   org_settings.drip_routing_send_capacity — when on, routing treats a drip
--   campaign as FULL for today when its sends today + routed-unsent backlog
--   reach its daily send cap (lib/drip/daily-sends.ts). A full campaign is
--   skipped and the lead goes to the next same-tag candidate by priority; it is
--   deferred only when every candidate is full. Off (default) = routing ignores
--   the send cap, exactly as before. Rollback = set false.
-- Re-runnable: ADD COLUMN IF NOT EXISTS. Constant default: no rewrite.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS drip_routing_send_capacity boolean NOT NULL DEFAULT false;--> statement-breakpoint
COMMENT ON COLUMN public.org_settings.drip_routing_send_capacity IS
  'Drip routing send capacity (0210): a campaign whose sends today + routed-unsent backlog reach its daily send cap is skipped; the lead overflows to the next same-tag candidate, deferred if all are full. Off = routing ignores the send cap.';
