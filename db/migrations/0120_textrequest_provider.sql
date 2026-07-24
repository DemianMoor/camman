-- Seed the Text Request SMS provider row (idempotent, additive) + add the
-- dashboard_id column to provider_phones (Text Request is dashboard-scoped —
-- one dashboard per sending number).
--
-- supports_api_send stays FALSE: the txr adapter's send() is a Phase 1
-- not-implemented stub. Flipping it true is the Phase 2 go-live step (same
-- pattern as SimpleTexting / Ahoi). Volume ceilings reflect the confirmed TFN
-- limit of 25 MPS: 25/s = 1500/min. The 24h cap starts conservative (30000,
-- matching Ahoi's TFN-era value) and is tunable in the provider UI; the
-- per-second rate is set PER NUMBER on provider_phones.max_sends_per_second
-- (target 25 for the TFN), NOT here.
--
-- Number + credential are NOT seeded here: they carry the live API key + the
-- real TFN (both pending Phase 0), and CamMan keeps secrets/numbers out of
-- migrations (cf. Ahoi, whose number/credential were seeded by a separate
-- script). The TFN phone row (with max_sends_per_second=25 + its dashboard_id)
-- is created via the phones UI once the real number + key exist.
--
-- Uses the single-org model: attach to the one organizations row (mirrors
-- 0107_seed_ahoi_provider.sql).
INSERT INTO sms_providers (
  sms_provider_id, org_id, name, supports_api_send, status,
  max_sends_per_minute, max_sends_per_24h
)
SELECT 'txr', o.id, 'Text Request', false, 'active', 1500, 30000
FROM organizations o
ON CONFLICT (sms_provider_id) DO NOTHING;
--> statement-breakpoint
-- Text Request dashboard binding for a sending number (nullable; TEXT holds an
-- integer or GUID id — TR's id type is unconfirmed in Phase 0). NULL for every
-- non-Text-Request number. The drain resolves stage -> provider_phone ->
-- dashboard_id at send time (Phase 2).
ALTER TABLE public.provider_phones
  ADD COLUMN IF NOT EXISTS dashboard_id text;
