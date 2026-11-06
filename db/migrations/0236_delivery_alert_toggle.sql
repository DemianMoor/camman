-- 0236: on/off switch for the low-delivery Telegram alert
-- (lib/reporting/low-delivery-alert.ts, cron /api/cron/delivery-alerts).
--
-- DEFAULT true: the owner asked for the alert, so it is on for every org the
-- moment the code ships; the Notifications settings page turns it off.
-- Additive and metadata-only (PG 11+ stores a constant default without a table
-- rewrite); lock_timeout so a busy notification_settings reader can't queue
-- the whole batch behind the ACCESS EXCLUSIVE lock.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.notification_settings
  ADD COLUMN IF NOT EXISTS delivery_alert_enabled boolean NOT NULL DEFAULT true;
