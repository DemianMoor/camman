-- Split the ADAPTER LOOKUP KEY out of sms_providers.sms_provider_id.
--
-- `sms_provider_id` currently does two jobs: it is the row's unique identity AND
-- the key the drain hands to getAdapter() (lib/sends/drain.ts selects
-- `p.sms_provider_id AS provider_key`). Because the column is UNIQUE, a second
-- TextHub account could not reuse the code `txh` and became its own row under
-- the invented code `txh2`, which the adapter registry then special-cases back
-- to the TextHub adapter.
--
-- `adapter_code` carries the connection type. `sms_provider_id` keeps being the
-- row's identity. After this, `txh2` is simply a TextHub-type row — no alias
-- needed in code.
--
-- STRICTLY ADDITIVE. One nullable column plus a backfill of existing rows. No
-- DROP, no destructive statement, nothing rewritten. `sms_provider_id` is
-- untouched and every existing query keeps working: the drain is switched to
-- read `adapter_code` in a SEPARATE, LATER deploy, only after adapter
-- resolution has been proven identical for all rows.
--
-- NULL means "no API adapter" (snx, smpl — sent through manually). That is a
-- real state, not missing data, so the column stays nullable with no default.
ALTER TABLE public.sms_providers
  ADD COLUMN IF NOT EXISTS adapter_code text;
--> statement-breakpoint
-- Backfill. Values are spelled out per row rather than copied blindly from
-- sms_provider_id, because txh2 is exactly the case a blind copy gets wrong:
-- its adapter is TextHub's, not an adapter called "txh2".
UPDATE public.sms_providers SET adapter_code = 'txh'
  WHERE adapter_code IS NULL AND sms_provider_id IN ('txh', 'txh2');
--> statement-breakpoint
UPDATE public.sms_providers SET adapter_code = 'ahi'
  WHERE adapter_code IS NULL AND sms_provider_id = 'ahi';
--> statement-breakpoint
UPDATE public.sms_providers SET adapter_code = 'txr'
  WHERE adapter_code IS NULL AND sms_provider_id = 'txr';
--> statement-breakpoint
UPDATE public.sms_providers SET adapter_code = 'tls'
  WHERE adapter_code IS NULL AND sms_provider_id = 'tls';
--> statement-breakpoint
-- snx / smpl are deliberately left NULL: they have no adapter in the registry
-- and are sent through manually. getAdapter() would throw for them today too,
-- which is why supports_api_send is false on both.
--
-- Index: the drain resolves adapter_code per stage on the send path. Tiny table
-- (7 rows), so this is about intent and future scale rather than current cost.
CREATE INDEX IF NOT EXISTS sms_providers_adapter_code_idx
  ON public.sms_providers (adapter_code)
  WHERE adapter_code IS NOT NULL;
