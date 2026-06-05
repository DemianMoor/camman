-- Per-provider auto-send window + scheduled-send "missed" marker.
--
-- send_window_* (minute-of-day in ET, 0–1439): the hours during which the
-- send-scheduled cron may auto-send for this provider, stored per day-type
-- (weekday / weekend). A pair applies only when BOTH bounds are set and
-- start < end; otherwise the app falls back to the default window
-- (08:00–21:00 ET). A scheduled send fires only inside its own ET day's
-- window, holds until that window opens, or is marked missed once the day's
-- window has closed — see lib/quiet-hours.ts.
--
-- KNOWN v1 LIMITATION: the window is evaluated in the sender's fixed ET zone,
-- not each recipient's local zone. Nationwide sends could reach Pacific
-- recipients before their local window opens. To revisit when we capture
-- per-recipient timezone data.
ALTER TABLE public.sms_providers
  ADD COLUMN send_window_weekday_start integer,
  ADD COLUMN send_window_weekday_end   integer,
  ADD COLUMN send_window_weekend_start integer,
  ADD COLUMN send_window_weekend_end   integer;

-- Terminal marker: a scheduled auto-send whose ET-day window closed before it
-- could fire. sent_at stays NULL so the stage is NOT locked (the post-send lock
-- keys on sent_at) and remains reschedulable; rescheduling clears this marker.
-- Distinct from a fired stage (sent_at set).
ALTER TABLE public.campaign_stages
  ADD COLUMN schedule_missed_at timestamp with time zone;
