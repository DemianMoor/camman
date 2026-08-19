-- Q4/Q5. Per-NUMBER carrier policy: an allow-list (Q4) and a daily cap (Q5),
-- carried on one child row per (number, carrier).
--
-- MACHINERY ONLY. This migration creates an EMPTY table and adds a column that
-- defaults to today's behaviour on all 35 numbers. With no rows and the boolean
-- true everywhere, every audience and every send is byte-for-byte what it is
-- today — and that property is itself an acceptance test
-- (scripts/verify-q4-carrier-allowlist.ts).
--
-- ⚠️ ABSENT ROW = ALLOWED AND UNCAPPED. The table is an EXCEPTION list, not an
-- allow-list in the "only these are permitted" sense. A number with no rows
-- sends to every carrier without limit, which is what makes the empty table a
-- no-op. Any future reader MUST preserve that default: reading absence as
-- "denied" would silently mute every number in the org.
--
--   allowed = false      -> this carrier is excluded from this number's audience
--   daily_limit = NULL   -> uncapped (Q5)
--   daily_limit = N      -> at most N sends to this carrier, per ET CALENDAR DAY
--
-- `allow_unknown_carrier` covers the three unknown-ish buckets together —
-- 'Unknown' (looked up, undetermined), 'Unmapped' (looked up, awaiting an admin
-- mapping) and 'Unidentified' (never looked up). They stay DISTINCT in the data
-- because they mean different things for reporting and for the lookup pipeline;
-- they are one switch in the UI because an operator's question is only ever
-- "may this number text people whose carrier we do not know?".
CREATE TABLE IF NOT EXISTS public.phone_carrier_limits (
  id serial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider_phone_id integer NOT NULL REFERENCES public.provider_phones(id) ON DELETE CASCADE,
  carrier_norm text NOT NULL,
  allowed boolean NOT NULL DEFAULT true,
  daily_limit integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT phone_carrier_limits_daily_limit_positive
    CHECK (daily_limit IS NULL OR daily_limit > 0)
);
--> statement-breakpoint
-- One policy row per (number, carrier). The org_id is part of the key so the
-- uniqueness is org-scoped like every other domain constraint here.
CREATE UNIQUE INDEX IF NOT EXISTS phone_carrier_limits_phone_carrier_uniq
  ON public.phone_carrier_limits (org_id, provider_phone_id, carrier_norm);
--> statement-breakpoint
-- The read is always "give me this number's policy rows", once per
-- materialization and once per drain batch.
CREATE INDEX IF NOT EXISTS phone_carrier_limits_phone_idx
  ON public.phone_carrier_limits (provider_phone_id);
--> statement-breakpoint
-- RLS: a tenant table needs an org-scoped policy even though only the server
-- writes it (docs/07-conventions.md — the anon key ships in the frontend
-- bundle). SELECT-only, mirroring stage_sends.
ALTER TABLE public.phone_carrier_limits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "phone_carrier_limits_select_own_org"
  ON public.phone_carrier_limits FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint
-- May this number text contacts whose carrier we could not determine? TRUE on
-- every existing row = today's behaviour (nothing is excluded on carrier
-- grounds). Never treat 'unknown' as ineligible by default — the conservative
-- rule in docs/07-conventions.md is that unknown must never silently suppress.
ALTER TABLE public.provider_phones
  ADD COLUMN IF NOT EXISTS allow_unknown_carrier boolean NOT NULL DEFAULT true;
