-- Migration 0199: lead_intake_hourly — the per-partner x tag x HOUR twin of
-- lead_intake_daily (hourly partner-intake Telegram digest, owner-approved
-- 2026-10-07).
--
-- ⚠️ WHY A SECOND COUNTER AND NOT A SCAN. The digest needs "leads received,
-- line-type split and lookups spent, per partner x tag, for the past hour".
-- lead_intake_daily only has the ET-day grain, and the rows cannot rebuild the
-- hour: landline leads are counted and then DELETED from lead_inbox (no
-- lead_events row either), and nothing ties a Telnyx lookup to a partner except
-- the lookups_spent counter itself.
--
-- ⚠️ WRITTEN BY THE SAME STATEMENT PATH AS THE DAILY ROW. bumpIntakeCounters
-- (lib/drip/counters.ts) upserts both tables with the same deltas on the same
-- connection/transaction, so for every ET day:
--     SUM(hourly rows inside the day) = the daily row     (per org x partner x tag)
-- The digest re-checks this invariant every hour and prints a warning line when
-- it breaks (lib/drip/intake-digest.ts).
--
-- hour_et is the START of the hour as an instant (timestamptz). ET's UTC offset
-- is a whole number of hours, so the ET hour boundary is the UTC hour boundary,
-- and the repeated 01:00 on the DST fall-back day stays two distinct rows.
-- The hour is the PROCESSING hour (when enrichment counted the lead), the same
-- clock the daily row's day_et uses — not the partner's received_at.
--
-- Rows start at the first hour after this ships; there is no backfill (the
-- daily table cannot be split into hours).
--
-- ADDITIVE. New table only.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE public.lead_intake_hourly (
  org_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  partner_key_id integer NOT NULL REFERENCES public.partner_keys(id) ON DELETE CASCADE,
  hour_et        timestamptz NOT NULL,
  interest_tag   text NOT NULL DEFAULT '',

  received       integer NOT NULL DEFAULT 0,
  mobile         integer NOT NULL DEFAULT 0,
  voip           integer NOT NULL DEFAULT 0,
  unknown        integer NOT NULL DEFAULT 0,
  landline       integer NOT NULL DEFAULT 0,
  rejected       integer NOT NULL DEFAULT 0,
  duplicate      integer NOT NULL DEFAULT 0,
  sandbox        integer NOT NULL DEFAULT 0,
  lookups_spent  integer NOT NULL DEFAULT 0,

  CONSTRAINT lead_intake_hourly_pkey
    PRIMARY KEY (org_id, partner_key_id, hour_et, interest_tag),

  -- An hour start is always on the hour. A mid-hour value would silently land
  -- in no digest window.
  CONSTRAINT lead_intake_hourly_on_the_hour_check
    CHECK (date_trunc('hour', hour_et) = hour_et),

  CONSTRAINT lead_intake_hourly_nonneg_check CHECK (
    received >= 0 AND mobile >= 0 AND voip >= 0 AND unknown >= 0 AND landline >= 0
    AND rejected >= 0 AND duplicate >= 0 AND sandbox >= 0 AND lookups_spent >= 0
  )
);
--> statement-breakpoint

-- The digest's scan (one org, one hour) and the invariant's (one org, one day).
CREATE INDEX lead_intake_hourly_org_hour_idx
  ON public.lead_intake_hourly (org_id, hour_et DESC);
--> statement-breakpoint

-- RLS matches lead_intake_daily: enabled, SELECT-only, org-scoped. Writes go
-- through the intake transaction with the trusted org id, never through an
-- end-user session, so there is deliberately no write policy.
ALTER TABLE public.lead_intake_hourly ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "lead_intake_hourly_select_own_org"
  ON public.lead_intake_hourly FOR SELECT
  USING (org_id = public.current_org_id());
