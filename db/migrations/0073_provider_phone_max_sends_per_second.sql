-- Migration 0073: move the per-second send rate to the PHONE NUMBER level.
--
-- The per-second rate is a carrier limit that depends on the NUMBER TYPE, and a
-- single provider can own numbers of different types (e.g. TextHub has both a
-- short code at 60/s and a toll-free number at 3/s). So the ceiling belongs on
-- provider_phones, not sms_providers. The drain resolves the rate from the
-- stage's provider_phone_id (campaign_stages.provider_phone_id → this column).
--
-- Nullable: NULL ⇒ the built-in default (DEFAULT_SENDS_PER_SECOND). Non-
-- destructive. The now-redundant sms_providers.max_sends_per_second (added in
-- 0072) is dropped in a FOLLOW-UP migration (0074) — only AFTER the code that
-- still reads it is no longer deployed (expand/contract; no in-flight drain
-- ever hits a missing column).
ALTER TABLE public.provider_phones
  ADD COLUMN max_sends_per_second integer;
