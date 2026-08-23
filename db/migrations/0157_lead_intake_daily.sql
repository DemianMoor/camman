-- Migration 0157: lead_intake_daily — the per-partner, per-ET-day counter
-- (Drip Phase 3).
--
-- ⚠️ THIS TABLE EXISTS BECAUSE THE ROWS DO NOT SURVIVE. Landline leads are
-- counted and then REMOVED from lead_inbox (ruled), so by the time Phase 7 asks
-- "how many numbers did this partner send us, and how many were unusable?" the
-- evidence is gone. The counter is written in the SAME TRANSACTION as the
-- delete, so there is no window in which a lead is neither a row nor a count.
--
-- ⚠️ Columns are one per OUTCOME, not a status enum, because a single lead
-- contributes to exactly one of them and Phase 7 needs them side by side. Per
-- ruling G19 voip and unknown are counted SEPARATELY from mobile even though
-- all three are processed identically — the whole point of keeping them is that
-- Phase 4 may later want to filter, and it cannot decide on a number it cannot
-- see.
--
-- SANDBOX IS EXCLUSIVE. A sandbox lead increments `sandbox` and NOTHING ELSE —
-- not received, not mobile, not landline. Phase 7 can therefore report real
-- partner volume without filtering, which is the whole reason sandbox leads are
-- flagged rather than discarded.
--
-- lookups_spent counts TELNYX CALLS ACTUALLY MADE (cache misses only), not
-- leads. It is the only way to produce the parent card's "separate lookup-cost
-- column" once landline rows are gone: cost is per call, and a cache hit costs
-- nothing. Counting leads here would overstate spend by whatever the cache
-- served — which for a partner resending the same numbers is most of them.
--
-- day_et is a DATE resolved in application code from campaignDayBoundsUtc(),
-- never by a functional predicate on a timestamp (sargability convention).
--
-- ADDITIVE. New table only.

CREATE TABLE public.lead_intake_daily (
  org_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  partner_key_id integer NOT NULL REFERENCES public.partner_keys(id) ON DELETE CASCADE,
  day_et         date NOT NULL,

  -- Every real (non-sandbox) lead captured that day.
  received       integer NOT NULL DEFAULT 0,
  -- Outcome split. mobile + voip + unknown + landline + rejected + duplicate
  -- should reconcile to `received` once a day is fully drained.
  mobile         integer NOT NULL DEFAULT 0,
  voip           integer NOT NULL DEFAULT 0,
  unknown        integer NOT NULL DEFAULT 0,
  landline       integer NOT NULL DEFAULT 0,
  rejected       integer NOT NULL DEFAULT 0,
  duplicate      integer NOT NULL DEFAULT 0,

  -- Exclusive of every column above.
  sandbox        integer NOT NULL DEFAULT 0,

  -- Telnyx calls actually made. Cache hits are NOT counted.
  lookups_spent  integer NOT NULL DEFAULT 0,

  PRIMARY KEY (partner_key_id, day_et),

  CONSTRAINT lead_intake_daily_nonneg_check CHECK (
    received >= 0 AND mobile >= 0 AND voip >= 0 AND unknown >= 0 AND landline >= 0
    AND rejected >= 0 AND duplicate >= 0 AND sandbox >= 0 AND lookups_spent >= 0
  )
);
--> statement-breakpoint

CREATE INDEX lead_intake_daily_org_day_idx
  ON public.lead_intake_daily (org_id, day_et DESC);
--> statement-breakpoint

ALTER TABLE public.lead_intake_daily ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "lead_intake_daily_select_own_org"
  ON public.lead_intake_daily FOR SELECT
  USING (org_id = public.current_org_id());
