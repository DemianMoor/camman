-- Migration 0118: preflight snapshot + abort columns for lane/scheduled stages (P5/P6).
--
-- The send-preflight cron (P5) computes a stage's resolved audience + exclusion
-- breakdown (opt-out / content-dedup / split / lane / predicted 1-hour phone
-- dedup) ~15 min before it materializes, posts a Telegram digest, and persists
-- the result for the /sends/autopilot weekly view (P6):
--   preflight_result        jsonb  — { will_send, excluded{...}, estimated_drain_seconds, blockers[] }
--   preflight_computed_at    — when that snapshot was taken
--   preflight_notified_at    — set once when the Telegram digest included the stage (post-once dedup)
--   preflight_aborted_at     — operator abort during the preflight window; Phase A due-selection excludes it
-- All additive/nullable, NULL for every existing stage — no table rewrite.
ALTER TABLE public.campaign_stages
  ADD COLUMN IF NOT EXISTS preflight_result jsonb,
  ADD COLUMN IF NOT EXISTS preflight_computed_at timestamptz,
  ADD COLUMN IF NOT EXISTS preflight_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS preflight_aborted_at timestamptz;
