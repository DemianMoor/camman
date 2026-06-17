-- Migration 0074: drop the now-orphaned sms_providers.max_sends_per_second.
--
-- The per-second rate moved to provider_phones in 0073 (it's a carrier limit
-- that differs by number type within one provider). The sms_providers column
-- added in 0072 is no longer read by any code.
--
-- EXPAND/CONTRACT — apply this ONLY AFTER the code that still reads
-- sms_providers.max_sends_per_second (the pre-0073 drain ctx query) is no longer
-- deployed. Applying it before that deploy would make an in-flight drain's
-- SELECT reference a missing column. Safe once the phone-level code is live.
ALTER TABLE public.sms_providers
  DROP COLUMN IF EXISTS max_sends_per_second;
