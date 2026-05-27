-- Fold short codes into provider_phones as a `number_type` attribute, and
-- retire the separate provider_short_codes table (added in 0041).
--
-- number_type: '10dlc' / 'toll_free' (E.164 phone numbers) or 'short_code'
-- (5–6 digit numeric code; geo columns stay NULL). One type per number.
-- Existing phones backfill to '10dlc' (the column default).

ALTER TABLE public.provider_phones
  ADD COLUMN number_type text NOT NULL DEFAULT '10dlc';
--> statement-breakpoint

ALTER TABLE public.provider_phones
  ADD CONSTRAINT "provider_phones_number_type_check"
  CHECK (number_type IN ('10dlc', 'toll_free', 'short_code'));
--> statement-breakpoint

-- Migrate existing short codes into provider_phones (number_type='short_code').
-- The code value lands in phone_number; geo columns stay NULL. ON CONFLICT
-- guards the (org_id, phone_number) unique index in the unlikely event a code
-- collides with an existing phone.
INSERT INTO public.provider_phones
  (org_id, provider_id, brand_id, phone_number, cost_per_sms, number_type,
   status, archived_at, created_at)
SELECT
  org_id, provider_id, brand_id, short_code, cost_per_sms, 'short_code',
  status, archived_at, created_at
FROM public.provider_short_codes
ON CONFLICT (org_id, phone_number) DO NOTHING;
--> statement-breakpoint

-- Retire the standalone table (its RLS policies drop with it).
DROP TABLE public.provider_short_codes;
