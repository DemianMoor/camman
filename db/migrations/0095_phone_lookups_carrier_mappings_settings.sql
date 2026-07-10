-- Telnyx Number Lookup — phase 1a: global cache, carrier bucket mappings, and
-- account-global lookup settings. All three are GLOBAL (no org_id): carrier data
-- is a fact about a phone number, not about a tenant, and rates/cap/pause govern
-- the single Telnyx account. Written exclusively server-side via the privileged
-- Drizzle/postgres-js connection (BYPASSES RLS, as does service_role).
--
-- RLS: enabled POLICY-LESS on all three (geoip_cache precedent, migration 0066).
-- There is no org_id to scope by and no legitimate anon/authenticated PostgREST
-- caller — the admin UI reads through server API routes on the Drizzle role.
-- Policy-less = default-deny for non-bypass roles: closes the PostgREST door the
-- Supabase advisor flags while leaving server code working. Adding an
-- "authenticated read" policy would instead EXPOSE this global table of phone
-- numbers to every logged-in user — deliberately not done.

CREATE TABLE IF NOT EXISTS public.phone_lookups (
  phone         text PRIMARY KEY,               -- E.164, normalized (+1XXXXXXXXXX) — matches contacts.phone_number
  line_type     text NOT NULL,
  carrier_raw   text,
  carrier_norm  text NOT NULL DEFAULT 'Unknown',
  ocn           text,
  spid          text,
  ported        boolean,
  ported_date   date,
  source        text NOT NULL,
  lookup_status text NOT NULL DEFAULT 'complete',
  retry_count   int NOT NULL DEFAULT 0,
  raw_response  jsonb,
  looked_up_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT phone_lookups_line_type_check
    CHECK (line_type IN ('mobile', 'landline', 'voip', 'toll_free', 'unknown')),
  CONSTRAINT phone_lookups_carrier_norm_check
    CHECK (carrier_norm IN ('AT&T', 'T-Mobile', 'Verizon', 'Other Mobile', 'VoIP', 'Unknown', 'Unmapped')),
  CONSTRAINT phone_lookups_source_check
    CHECK (source IN ('telnyx', 'csv_import', 'manual_edit', 'dlr_inferred')),
  CONSTRAINT phone_lookups_lookup_status_check
    CHECK (lookup_status IN ('complete', 'failed'))
);
--> statement-breakpoint

-- Retry sweep: partial index over failed rows only.
CREATE INDEX IF NOT EXISTS phone_lookups_failed_idx
  ON public.phone_lookups (retry_count) WHERE lookup_status = 'failed';
--> statement-breakpoint

-- Admin unmapped queue: raw strings needing a bucket assignment.
CREATE INDEX IF NOT EXISTS phone_lookups_unmapped_idx
  ON public.phone_lookups (carrier_raw) WHERE carrier_norm = 'Unmapped';
--> statement-breakpoint

ALTER TABLE public.phone_lookups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Raw carrier string -> one of the six buckets (+ 'Unmapped' sentinel handled in
-- code, never stored here). raw_name is matched case-insensitively in code via a
-- normalized lookup; stored here as the exact observed string for auditability.
CREATE TABLE IF NOT EXISTS public.carrier_mappings (
  raw_name     text PRIMARY KEY,
  carrier_norm text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  mapped_by    text,
  CONSTRAINT carrier_mappings_carrier_norm_check
    CHECK (carrier_norm IN ('AT&T', 'T-Mobile', 'Verizon', 'Other Mobile', 'VoIP', 'Unknown'))
);
--> statement-breakpoint

ALTER TABLE public.carrier_mappings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Best-effort seed of common US carrier legal-entity strings. Augmented from the
-- prior ~10k Telnyx run before first production lookup; the admin unmapped queue
-- catches anything not covered here. mapped_by='seed'.
INSERT INTO public.carrier_mappings (raw_name, carrier_norm, mapped_by) VALUES
  -- Verizon
  ('Cellco Partnership dba Verizon Wireless', 'Verizon', 'seed'),
  ('Cellco Partnership DBA Verizon Wireless', 'Verizon', 'seed'),
  ('Verizon Wireless', 'Verizon', 'seed'),
  ('Verizon', 'Verizon', 'seed'),
  -- AT&T
  ('AT&T Mobility LLC', 'AT&T', 'seed'),
  ('AT&T Mobility', 'AT&T', 'seed'),
  ('New Cingular Wireless PCS, LLC', 'AT&T', 'seed'),
  ('New Cingular Wireless PCS LLC', 'AT&T', 'seed'),
  ('AT&T', 'AT&T', 'seed'),
  -- T-Mobile (incl. legacy Sprint / Metro)
  ('T-Mobile USA, Inc.', 'T-Mobile', 'seed'),
  ('T-Mobile USA Inc', 'T-Mobile', 'seed'),
  ('T-Mobile', 'T-Mobile', 'seed'),
  ('Metro by T-Mobile', 'T-Mobile', 'seed'),
  ('MetroPCS', 'T-Mobile', 'seed'),
  ('Sprint', 'T-Mobile', 'seed'),
  ('Sprint Spectrum, L.P.', 'T-Mobile', 'seed'),
  ('Sprint Spectrum LP', 'T-Mobile', 'seed'),
  -- Other Mobile (regional carriers + major MVNOs)
  ('U.S. Cellular', 'Other Mobile', 'seed'),
  ('United States Cellular Corp.', 'Other Mobile', 'seed'),
  ('Cricket Wireless', 'Other Mobile', 'seed'),
  ('Cricket Wireless, LLC', 'Other Mobile', 'seed'),
  ('Mint Mobile', 'Other Mobile', 'seed'),
  ('Straight Talk', 'Other Mobile', 'seed'),
  ('TracFone Wireless, Inc.', 'Other Mobile', 'seed'),
  ('TracFone', 'Other Mobile', 'seed'),
  ('Boost Mobile', 'Other Mobile', 'seed'),
  ('Google Fi', 'Other Mobile', 'seed'),
  -- VoIP
  ('Bandwidth.com', 'VoIP', 'seed'),
  ('Bandwidth.com CLEC, LLC', 'VoIP', 'seed'),
  ('Onvoy, LLC', 'VoIP', 'seed'),
  ('Onvoy', 'VoIP', 'seed'),
  ('Twilio', 'VoIP', 'seed'),
  ('Telnyx LLC', 'VoIP', 'seed'),
  ('Telnyx', 'VoIP', 'seed'),
  ('Sinch', 'VoIP', 'seed'),
  ('Level 3 Communications, LLC', 'VoIP', 'seed'),
  ('Level 3', 'VoIP', 'seed'),
  ('Peerless Network', 'VoIP', 'seed')
ON CONFLICT (raw_name) DO NOTHING;
--> statement-breakpoint

-- Observed carrier strings from the 06/25/2026 Telnyx 10k run
-- (scripts/gen-carrier-seed.ts): 155 mappings, ~63% of carrier-attributed rows.
-- Generated from the 06/25/2026 Telnyx 10k run by scripts/gen-carrier-seed.ts
INSERT INTO public.carrier_mappings (raw_name, carrier_norm, mapped_by) VALUES
  ('ALASCOM, INC. DBA AT&T ALASKA', 'AT&T', 'seed'),
  ('Ameritech-AT&T Wireline/1', 'AT&T', 'seed'),
  ('AT&T', 'AT&T', 'seed'),
  ('AT&T ENTERPRISES, LLC', 'AT&T', 'seed'),
  ('AT&T Nodal Services/1', 'AT&T', 'seed'),
  ('BellSouth-AT&T Wireline/1', 'AT&T', 'seed'),
  ('Cingular Wireless/2', 'AT&T', 'seed'),
  ('NEW CINGULAR WIRELESS PCS, LLC', 'AT&T', 'seed'),
  ('NEW CINGULAR WIRELESS PCS, LLC - DC', 'AT&T', 'seed'),
  ('NEW CINGULAR WIRELESS PCS, LLC - GA', 'AT&T', 'seed'),
  ('NEW CINGULAR WIRELESS PCS, LLC - IL', 'AT&T', 'seed'),
  ('BOOST SUBSCRIBERCO L.L.C.', 'Other Mobile', 'seed'),
  ('Boost SubscriberCo LLC', 'Other Mobile', 'seed'),
  ('Boost SubscriberCo LLC-10X-NSR/2', 'Other Mobile', 'seed'),
  ('Carolina West Wireless', 'Other Mobile', 'seed'),
  ('CELLULAR SOUTH, INC.', 'Other Mobile', 'seed'),
  ('GCI COMMUNICATION CORP. DBA GENERAL COMMUNICATION', 'Other Mobile', 'seed'),
  ('Inland Cellular', 'Other Mobile', 'seed'),
  ('Keystone Wireless', 'Other Mobile', 'seed'),
  ('Keystone Wireless:6921 - SVR/2', 'Other Mobile', 'seed'),
  ('UNION TELEPHONE COMPANY', 'Other Mobile', 'seed'),
  ('UNITED STATES CELLULAR', 'Other Mobile', 'seed'),
  ('USCC', 'Other Mobile', 'seed'),
  ('AERIAL COMMUNICATIONS, INC.', 'T-Mobile', 'seed'),
  ('D&E/OMNIPOINT WIREL JOINT VENT LP DBA PCS ONE', 'T-Mobile', 'seed'),
  ('Metro PCS', 'T-Mobile', 'seed'),
  ('Metro PCS Communications Inc', 'T-Mobile', 'seed'),
  ('Metro PCS Communications Inc-SVR-10X/2', 'T-Mobile', 'seed'),
  ('Metro PCS-Royal St. Comm-SVR-10X/2', 'T-Mobile', 'seed'),
  ('METROPCS NETWORKS, LLC', 'T-Mobile', 'seed'),
  ('METROPCS, INC.', 'T-Mobile', 'seed'),
  ('OMNIPOINT COMMUNICATIONS CAP OPERATIONS, LLC', 'T-Mobile', 'seed'),
  ('OMNIPOINT COMMUNICATIONS ENTERPRISES, LP', 'T-Mobile', 'seed'),
  ('OMNIPOINT COMMUNICATIONS MIDWEST OPERATIONS, LLC', 'T-Mobile', 'seed'),
  ('OMNIPOINT COMMUNICATIONS, INC.', 'T-Mobile', 'seed'),
  ('OMNIPOINT COMMUNICATIONS, INC. - NJ', 'T-Mobile', 'seed'),
  ('OMNIPOINT COMMUNICATIONS, INC. - NY', 'T-Mobile', 'seed'),
  ('OMNIPOINT MIAMI E LICENSE, LLC', 'T-Mobile', 'seed'),
  ('POWERTEL ATLANTA LICENSES, INC.', 'T-Mobile', 'seed'),
  ('POWERTEL BIRMINGHAM LICENSES, INC.', 'T-Mobile', 'seed'),
  ('POWERTEL KENTUCKY LICENSES, INC.', 'T-Mobile', 'seed'),
  ('POWERTEL MEMPHIS LICENSES, INC.', 'T-Mobile', 'seed'),
  ('SUNCOM DBA T-MOBILE USA', 'T-Mobile', 'seed'),
  ('T-Mobile', 'T-Mobile', 'seed'),
  ('T-Mobile US-SVR-10X/2', 'T-Mobile', 'seed'),
  ('T-MOBILE USA, INC.', 'T-Mobile', 'seed'),
  ('VOICESTREAM GSM I, LLC', 'T-Mobile', 'seed'),
  ('BELL ATLANTIC MOBILE, INC', 'Verizon', 'seed'),
  ('CELLCO PARTNERSHIP DBA VERIZON WIRELESS', 'Verizon', 'seed'),
  ('CELLCO PARTNERSHIP DBA VERIZON WIRELESS - AZ', 'Verizon', 'seed'),
  ('CELLCO PARTNERSHIP DBA VERIZON WIRELESS - CA', 'Verizon', 'seed'),
  ('CELLCO PARTNERSHIP DBA VERIZON WIRELESS - CT', 'Verizon', 'seed'),
  ('CELLCO PARTNERSHIP DBA VERIZON WIRELESS - FL', 'Verizon', 'seed'),
  ('CELLCO PARTNERSHIP DBA VERIZON WIRELESS - IA', 'Verizon', 'seed'),
  ('CELLCO PARTNERSHIP DBA VERIZON WIRELESS - MI', 'Verizon', 'seed'),
  ('CELLCO PARTNERSHIP DBA VERIZON WIRELESS - MO', 'Verizon', 'seed'),
  ('CELLCO PARTNERSHIP DBA VERIZON WIRELESS - NJ', 'Verizon', 'seed'),
  ('CELLCO PARTNERSHIP DBA VERIZON WIRELESS - NM', 'Verizon', 'seed'),
  ('CELLCO PARTNERSHIP DBA VERIZON WIRELESS - OH', 'Verizon', 'seed'),
  ('CELLCO PARTNERSHIP DBA VERIZON WIRELESS - PA', 'Verizon', 'seed'),
  ('CELLCO PARTNERSHIP DBA VERIZON WIRELESS - SC', 'Verizon', 'seed'),
  ('CELLCO PARTNERSHIP DBA VERIZON WIRELESS - TN', 'Verizon', 'seed'),
  ('CELLCO PARTNERSHIP DBA VERIZON WIRELESS - TX', 'Verizon', 'seed'),
  ('CELLCO PARTNERSHIP DBA VERIZON WIRELESS - WA', 'Verizon', 'seed'),
  ('VERIZON DELAWARE, INC.', 'Verizon', 'seed'),
  ('Verizon FDV/1', 'Verizon', 'seed'),
  ('VERIZON MARYLAND, INC.', 'Verizon', 'seed'),
  ('VERIZON NEW ENGLAND INC.', 'Verizon', 'seed'),
  ('VERIZON NEW JERSEY, INC.', 'Verizon', 'seed'),
  ('VERIZON NEW YORK, INC.', 'Verizon', 'seed'),
  ('VERIZON NORTH, INC.', 'Verizon', 'seed'),
  ('VERIZON PENNSYLVANIA, INC.', 'Verizon', 'seed'),
  ('VERIZON SOUTH, INC.', 'Verizon', 'seed'),
  ('VERIZON VIRGINIA, INC.', 'Verizon', 'seed'),
  ('VERIZON WASHINGTON DC, INC.', 'Verizon', 'seed'),
  ('Verizon Wireless', 'Verizon', 'seed'),
  ('Verizon Wireless:6006 - SVR/2', 'Verizon', 'seed'),
  ('Verizon/1', 'Verizon', 'seed'),
  ('AHOI LLC', 'VoIP', 'seed'),
  ('BANDWIDTH.COM', 'VoIP', 'seed'),
  ('BANDWIDTH.COM CLEC, LLC', 'VoIP', 'seed'),
  ('BANDWIDTH.COM CLEC, LLC - TX', 'VoIP', 'seed'),
  ('BANDWIDTH.COM-NSR-10X/1', 'VoIP', 'seed'),
  ('BHN IP ENABLED SERVICES, LLC', 'VoIP', 'seed'),
  ('Brightlink Communications', 'VoIP', 'seed'),
  ('CENTURYLINK COMMUNICATIONS, LLC', 'VoIP', 'seed'),
  ('CENTURYTEL OF WASHINGTON, INC. DBA CENTURYLINK', 'VoIP', 'seed'),
  ('CHARTER IP ENABLED SERVICES, LLC', 'VoIP', 'seed'),
  ('CLEAR RATE COMMUNICATIONS, LLC', 'VoIP', 'seed'),
  ('Comcast IP Phone NER/1', 'VoIP', 'seed'),
  ('Comcast IP Phone/1', 'VoIP', 'seed'),
  ('commio', 'VoIP', 'seed'),
  ('commio-10X-Port/4', 'VoIP', 'seed'),
  ('COMMIO, LLC', 'VoIP', 'seed'),
  ('CSCWirelessLLCdbaAlticeMobile-NSR/2', 'VoIP', 'seed'),
  ('FIVE9, INC.', 'VoIP', 'seed'),
  ('FRACTEL, LLC', 'VoIP', 'seed'),
  ('HDCarrier-Port-10X/4', 'VoIP', 'seed'),
  ('IP HORIZON LLC', 'VoIP', 'seed'),
  ('IP Horizon-Port/4', 'VoIP', 'seed'),
  ('LEAP TELECOM, LLC', 'VoIP', 'seed'),
  ('LEVEL 3 COMMUNICATIONS, LLC', 'VoIP', 'seed'),
  ('LEVEL 3 COMMUNICATIONS, LLC - CA', 'VoIP', 'seed'),
  ('LEVEL 3 COMMUNICATIONS, LLC - NJ', 'VoIP', 'seed'),
  ('LEVEL 3 COMMUNICATIONS, LLC - NY', 'VoIP', 'seed'),
  ('LEVEL 3 COMMUNICATIONS, LLC - OH', 'VoIP', 'seed'),
  ('LEVEL 3 OF TELECOM OF TEXAS, LLC', 'VoIP', 'seed'),
  ('LEVEL 3 TELECOM OF CALIFORNIA, LP', 'VoIP', 'seed'),
  ('LEVEL 3 TELECOM OF MARYLAND, LLC', 'VoIP', 'seed'),
  ('LEVEL 3 TELECOM OF NEW YORK, LP', 'VoIP', 'seed'),
  ('LEVEL 3 TELECOM OF TENNESSEE, LLC', 'VoIP', 'seed'),
  ('Level 3/1', 'VoIP', 'seed'),
  ('MCC TELEPHONY LLC', 'VoIP', 'seed'),
  ('ONVOY SPECTRUM, LLC', 'VoIP', 'seed'),
  ('ONVOY, LLC', 'VoIP', 'seed'),
  ('ONVOY, LLC - CA', 'VoIP', 'seed'),
  ('ONVOY, LLC - IN', 'VoIP', 'seed'),
  ('ONVOY, LLC - NJ', 'VoIP', 'seed'),
  ('ONVOY, LLC - NV', 'VoIP', 'seed'),
  ('ONVOY, LLC - TX', 'VoIP', 'seed'),
  ('ONVOY, LLC - VA', 'VoIP', 'seed'),
  ('ONVOY, LLC- NY', 'VoIP', 'seed'),
  ('ONVOY, LLCV', 'VoIP', 'seed'),
  ('Peerless', 'VoIP', 'seed'),
  ('PEERLESS 373F', 'VoIP', 'seed'),
  ('PEERLESS NETWORK OF CALIFORNIA, LLC', 'VoIP', 'seed'),
  ('PEERLESS NETWORK OF MINNESOTA, LLC', 'VoIP', 'seed'),
  ('PEERLESS NETWORK OF NEW JERSEY, LLC', 'VoIP', 'seed'),
  ('PEERLESS NETWORK OF NEW YORK, LLC', 'VoIP', 'seed'),
  ('PEERLESS NETWORK OF OHIO, LLC', 'VoIP', 'seed'),
  ('PEERLESS NETWORK OF TEXAS, LLC', 'VoIP', 'seed'),
  ('PEERLESS NETWORK OF WISCONSIN, LLC', 'VoIP', 'seed'),
  ('Peerless-NSR-Port/1', 'VoIP', 'seed'),
  ('Sinch', 'VoIP', 'seed'),
  ('Sinch Voice', 'VoIP', 'seed'),
  ('Sinch Voice-NSR-10X-Port/1', 'VoIP', 'seed'),
  ('Sinch-Onvoy Spectrum-NSR-10X/2', 'VoIP', 'seed'),
  ('SKYE TELECOM LLC DBA SKYETEL', 'VoIP', 'seed'),
  ('TDS METROCOM, LLC', 'VoIP', 'seed'),
  ('TELNYX LLC', 'VoIP', 'seed'),
  ('Telnyx/4', 'VoIP', 'seed'),
  ('TERRA NOVA TELECOM INC.', 'VoIP', 'seed'),
  ('Terra Nova Telecom-AST/4', 'VoIP', 'seed'),
  ('THE VOICE APPLICATION NETWORK, LLC', 'VoIP', 'seed'),
  ('TON80 COMMUNICATIONS, LLC', 'VoIP', 'seed'),
  ('TWC IP ENABLED SERVICES, LLC', 'VoIP', 'seed'),
  ('Twilio International', 'VoIP', 'seed'),
  ('Twilio International-10X/4', 'VoIP', 'seed'),
  ('U.S. TELEPACIFIC CORP. DBA TPX COMMUNICATIONS', 'VoIP', 'seed'),
  ('VoIP Innovations', 'VoIP', 'seed'),
  ('VOIP INNOVATIONS, LLC', 'VoIP', 'seed'),
  ('Vonage', 'VoIP', 'seed'),
  ('VONAGE AMERICA LLC', 'VoIP', 'seed'),
  ('Vonage: 197D - NSR/4', 'VoIP', 'seed'),
  ('WAVENATION, LLC', 'VoIP', 'seed')
ON CONFLICT (raw_name) DO NOTHING;
--> statement-breakpoint

-- Account-global lookup config. Single row enforced by a boolean PK fixed to true
-- (CHECK id) — the canonical Postgres single-row-table guard. Rates are here
-- because Telnyx exposes no pricing API; cost previews and actual-cost both read
-- these. Warsaw-tz daily cap, kill switch mirrors org_settings.sends_paused.
CREATE TABLE IF NOT EXISTS public.lookup_settings (
  id                     boolean PRIMARY KEY DEFAULT true,
  lookup_paused          boolean NOT NULL DEFAULT false,
  lookup_daily_cap       int NOT NULL DEFAULT 50000,
  lookup_rate_base       numeric NOT NULL DEFAULT 0.0015,
  lookup_rate_mobile     numeric NOT NULL DEFAULT 0.0025,
  lookup_concurrency_rps int NOT NULL DEFAULT 10,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lookup_settings_single_row CHECK (id)
);
--> statement-breakpoint

ALTER TABLE public.lookup_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

INSERT INTO public.lookup_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
