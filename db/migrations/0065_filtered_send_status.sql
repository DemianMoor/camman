-- Migration 0065: add 'filtered' to stage_sends.status.
--
-- TextHub "Suppressed" visibility. When a send is rejected with the structured
-- envelope {"response":"Error occured, unsubscribed the phone number",
-- "status":"Suppressed"} (HTTP 404) — TextHub refusing a number it blocks on
-- ITS side — the drain now records the row as status='filtered' instead of
-- 'failed'. A distinct, operator-visible bucket so the volume of provider
-- suppression is separable from genuine send failures (bad number, transport).
--
-- LABEL ONLY: 'filtered' does NOT add the number to opt_outs and does NOT exclude
-- it from future campaigns. It is purely a classification of the send outcome.
-- (Auto opt-out capture / pre-send skipping is a separate, deferred decision.)
--
-- Non-destructive: widens the CHECK by one allowed value. Existing rows and code
-- are unaffected; no data is migrated (the existing 262 historical suppressions
-- stay status='failed' — backfilling them is intentionally out of scope here).

ALTER TABLE stage_sends DROP CONSTRAINT stage_sends_status_check;
ALTER TABLE stage_sends ADD CONSTRAINT stage_sends_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'rejected', 'filtered'));
