-- Carrier Normalization v2 — resolver-chain schema (enhancement to the Telnyx
-- carrier layer, migrations 0095–0102). Turns the single exact-string map lookup
-- (lib/telnyx/map-carrier.ts `resolveCarrierNorm`) into a priority chain:
--   1. Telnyx `normalized_carrier` (newly ingested)   2. learned carrier_mappings
--   3. carrier_patterns (regex/substring)             4. Unmapped -> AI triage
--
-- All changes are ADDITIVE. The new chain is gated at runtime by
-- `lookup_settings.carrier_resolver_v2` (DEFAULT false): until the flag is
-- flipped, every path keeps the current v1 behaviour, so applying this migration
-- changes no data. Bucket enum is UNCHANGED — the six existing buckets
-- (AT&T, T-Mobile, Verizon, Other Mobile, VoIP, Unknown) plus the Unmapped /
-- Unidentified sentinels stay exactly as they are.

-- 1. Store Telnyx's own `normalized_carrier` field (chain step 1). Nullable:
--    Telnyx populates it on only ~39% of rows. Filled on new lookups from the
--    payload (lib/telnyx/build-lookup-row.ts) and backfilled from the retained
--    `raw_response` jsonb for existing rows (no re-pay).
ALTER TABLE public.phone_lookups
  ADD COLUMN IF NOT EXISTS normalized_carrier text;
--> statement-breakpoint

-- 2. Pattern rules: broad, seeded, human-owned regex rules matched against the
--    NORMALIZED carrier key (chain step 3 — a fallback after the exact mapping).
--    Global (no org_id) like the other carrier tables; policy-less RLS (the
--    phone_lookups / geoip_cache precedent — server-only, no PostgREST caller).
CREATE TABLE IF NOT EXISTS public.carrier_patterns (
  id         bigserial PRIMARY KEY,
  pattern    text NOT NULL,                 -- POSIX/JS regex, tested against the normalized key
  brand      text NOT NULL,
  priority   int  NOT NULL DEFAULT 100,     -- lower = evaluated first
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carrier_patterns_pattern_uniq UNIQUE (pattern),
  CONSTRAINT carrier_patterns_brand_check
    CHECK (brand IN ('AT&T', 'T-Mobile', 'Verizon', 'Other Mobile', 'VoIP', 'Unknown'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS carrier_patterns_active_priority_idx
  ON public.carrier_patterns (priority) WHERE is_active;
--> statement-breakpoint

ALTER TABLE public.carrier_patterns ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Seed with the majors (brief §11). Patterns are written against the NORMALIZED
-- key form: uppercased, punctuation (. , -) collapsed to spaces, whitespace
-- re-collapsed, route/SPID suffixes stripped (see lib/carrier/normalize-key.ts).
-- So "T-Mobile" and "T-Mobile US-SVR-10X/2" both normalize to keys matched by
-- "T MOBILE". `&` is preserved (AT&T stays AT&T). Alternations, first-match-wins
-- by priority. Exact-mapping (step 2) still wins over any pattern.
INSERT INTO public.carrier_patterns (pattern, brand, priority) VALUES
  ('T MOBILE|METRO ?PCS|OMNIPOINT|POWERTEL|VOICESTREAM|SUNCOM|SPRINT|AERIAL COMMUNICATIONS', 'T-Mobile', 10),
  ('AT&T|CINGULAR|PACIFIC BELL|BELLSOUTH|AMERITECH|SOUTHWESTERN BELL|ILLINOIS BELL|ALASCOM', 'AT&T', 10),
  ('VERIZON|CELLCO|BELL ATLANTIC|MCIMETRO', 'Verizon', 10),
  ('US CELLULAR|UNITED STATES CELLULAR|USCC|CELLULAR SOUTH|CAROLINA WEST|INLAND CELLULAR|UNION TELEPHONE|BOOST|CRICKET|MINT MOBILE|STRAIGHT TALK|TRACFONE|GOOGLE FI', 'Other Mobile', 20),
  ('BANDWIDTH|TWILIO|SINCH|LEVEL 3|COMMIO|TELNYX|PEERLESS|INTELIQUENT|ONVOY|VONAGE|PLIVO|8X8|BRIGHTLINK|CENTURYLINK|SKYETEL|VOIP INNOVATIONS|FIVE9|FRACTEL', 'VoIP', 30)
ON CONFLICT (pattern) DO NOTHING;
--> statement-breakpoint

-- 3. Feature flag on the singleton settings row. DEFAULT false = keep v1 until
--    the backfill has been reviewed and the flag is deliberately flipped.
ALTER TABLE public.lookup_settings
  ADD COLUMN IF NOT EXISTS carrier_resolver_v2 boolean NOT NULL DEFAULT false;
