-- 0213: drip routing hour-level overflow. Additive only; ships dark.
--   org_settings.drip_routing_hour_overflow — when on (and drip_routing_send_capacity
--   on), routing also skips a candidate whose CURRENT HOUR is full (hourly cap,
--   window open) and diverts the lead to the next same-tag candidate with room.
--   Divert only, never defer: if every candidate is only hour-full the lead goes to
--   the best-ranked one anyway (it queues, as before). Off = day-level only.
-- Re-runnable: ADD COLUMN IF NOT EXISTS. Constant default: no rewrite.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS drip_routing_hour_overflow boolean NOT NULL DEFAULT false;--> statement-breakpoint
COMMENT ON COLUMN public.org_settings.drip_routing_hour_overflow IS
  'Drip routing hour-level overflow (0213): divert a lead from a candidate whose current hour is full to the next same-tag candidate with hourly room. Never defers. Needs drip_routing_send_capacity. Off = day-level only.';
