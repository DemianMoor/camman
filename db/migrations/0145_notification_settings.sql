-- Per-org Telegram notification settings: which notification types fire and
-- on what schedule. Loaded by app/api/cron/telegram-report on every tick;
-- missing row → cron falls back to the hard-coded defaults in
-- lib/reporting/telegram-report-format.ts (same behaviour as before this
-- migration). Times are Europe/Warsaw (the timezone the cron already uses).
--
-- active_weekdays stores ISO weekday numbers (1=Mon … 7=Sun). The default
-- '{1,2,3,4,5,6,7}' matches the pre-migration behaviour where every day ran.
-- hourly_interval_hours controls how many hours between hourly updates within
-- the window (1 = every hour, 2 = every other hour, 3 = every third hour).
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
  hourly_window_to smallint NOT NULL DEFAULT 23
    CONSTRAINT notification_settings_hourly_to_range
      CHECK (hourly_window_to >= 0 AND hourly_window_to <= 23),
  -- 1 = every hour, 2 = every 2 h, 3 = every 3 h
  hourly_interval_hours smallint NOT NULL DEFAULT 1
    CONSTRAINT notification_settings_interval_values
      CHECK (hourly_interval_hours IN (1, 2, 3)),
  -- ISO weekday numbers that receive updates (1=Mon … 7=Sun)
  active_weekdays smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "notification_settings_select_own_org"
  ON public.notification_settings FOR SELECT
  USING (org_id = public.current_org_id());
