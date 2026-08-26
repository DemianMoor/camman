-- Per-org Telegram notification settings: which notification types fire and
-- on what schedule. Loaded by app/api/cron/telegram-report on every tick;
-- missing row -> cron falls back to the hard-coded defaults in
-- lib/reporting/telegram-report-format.ts, which mirror these column defaults.
-- Times are Europe/Warsaw (the timezone the cron already uses).
--
-- EVERY DEFAULT HERE REPRODUCES THE HARD-CODED BEHAVIOUR THIS TABLE REPLACES,
-- so applying this migration and deploying changes nothing until an operator
-- edits the row. The two that are easy to get wrong:
--
--   hourly_window_to = 1, NOT 23. The old window was 16:00-01:59, not 16:00-
--   23:59 -- `(hour === 0 || hour === 1)` was a second branch in decideFormat,
--   which reads as a separate rule but is really the tail of the same evening
--   window. from(16) > to(1) is what marks the window as wrapping midnight.
--
--   active_weekdays = {1..6}, NOT {1..7}. Sunday evening was excluded
--   (`isoDow !== 7`), and so was Monday 00:00-01:59 (`isoDow !== 1`) because
--   those two hours belong to SUNDAY's window, not Monday's. The weekday set
--   is therefore matched against the day the window STARTED on, not the
--   wall-clock day -- see hourlyOwningDow() in telegram-report-format.ts.
--
-- active_weekdays gates the HOURLY updates only. The daily summary has never
-- been weekday-gated (it fired at 10:00 seven days a week) and still isn't;
-- disabling it is what daily_report_enabled is for.
--
-- hourly_interval_hours controls the gap between updates inside the window
-- (1 = every hour, 2 = every other hour, 3 = every third), measured from
-- hourly_window_from.
CREATE TABLE IF NOT EXISTS public.notification_settings (
  org_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- type toggles
  daily_report_enabled boolean NOT NULL DEFAULT true,
  hourly_report_enabled boolean NOT NULL DEFAULT true,
  stall_alert_enabled boolean NOT NULL DEFAULT true,
  unjoinable_alert_enabled boolean NOT NULL DEFAULT true,
  -- schedule: daily summary
  daily_report_hour smallint NOT NULL DEFAULT 10
    CONSTRAINT notification_settings_daily_hour_range
      CHECK (daily_report_hour >= 0 AND daily_report_hour <= 23),
  -- schedule: hourly-updates window
  hourly_window_from smallint NOT NULL DEFAULT 16
    CONSTRAINT notification_settings_hourly_from_range
      CHECK (hourly_window_from >= 0 AND hourly_window_from <= 23),
  -- 1, not 23: the live window is 16:00-01:59 and wraps midnight.
  hourly_window_to smallint NOT NULL DEFAULT 1
    CONSTRAINT notification_settings_hourly_to_range
      CHECK (hourly_window_to >= 0 AND hourly_window_to <= 23),
  -- 1 = every hour, 2 = every 2 h, 3 = every 3 h
  hourly_interval_hours smallint NOT NULL DEFAULT 1
    CONSTRAINT notification_settings_interval_values
      CHECK (hourly_interval_hours IN (1, 2, 3)),
  -- ISO weekday numbers whose HOURLY window runs (1=Mon .. 7=Sun). Sunday is
  -- out by default, matching the behaviour this table replaces.
  active_weekdays smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6}'
    CONSTRAINT notification_settings_weekday_values
      CHECK (active_weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "notification_settings_select_own_org"
  ON public.notification_settings FOR SELECT
  USING (org_id = public.current_org_id());
