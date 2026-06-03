-- Per-stage "approved to send" gate for the real-send drain.
--
-- One of three gates the drain checks (alongside the SEND_ENABLED env
-- kill-switch and the CRON_SECRET on the endpoint). Default false — a stage's
-- materialized send batch is never drained until explicitly approved.
ALTER TABLE public.campaign_stages
  ADD COLUMN send_approved boolean NOT NULL DEFAULT false;
