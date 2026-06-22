-- Emergency hard-stop for live SMS sending (org-level).
--
-- `sends_paused` is a SECOND, dedicated kill-switch on org_settings, distinct
-- from `sends_enabled` (the daily operational on/off). The "Today's sends"
-- screen flips this for an instant org-wide pause: the real-send drain re-reads
-- it every batch, so engaging it halts any in-flight send at the next batch
-- boundary and refuses to start new ones — no further message is submitted via
-- the provider API until someone clicks Proceed. Default FALSE (not paused).
-- _at/_by are denormalized "who/when last flipped"; full history lives in
-- org_setting_events (setting_key = 'sends_paused').

ALTER TABLE org_settings
  ADD COLUMN sends_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN sends_paused_at timestamptz,
  ADD COLUMN sends_paused_by uuid;
