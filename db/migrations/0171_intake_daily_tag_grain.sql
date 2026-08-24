-- Migration 0171: partner x TAG x ET-day grain for the intake counters
-- (Drip Phase 7, ruling R3).
--
-- ⚠️ WHY A COUNTER AND NOT A SCAN. The report needs "leads received including
-- landlines", and G4 discards landlines at intake -- there is no contact, no
-- stage_send and no journey to count later. Only a counter written in the intake
-- transaction can carry that number, at any volume. A live aggregate over
-- lead_events would also be a ~1.5M-row scan per page load at 50K leads/day.
--
-- ⚠️ TAG SEMANTICS -- the RESOLVED tag, never the supplied one.
-- partner_keys.interest_tag_mode is 'force' or 'default':
--   force   -> the key's tag always wins, whatever the payload said
--   default -> the payload's tag if present, else the key's, else none
-- The counter stores what ROUTING will actually match on, because a report keyed
-- on the supplied tag would not explain where the leads went. lib/intake/
-- capture.ts already computes exactly this value; it is passed straight through.
--
-- ⚠️ '' NOT NULL FOR "no tag resolved". NULL never equals NULL in a unique
-- index, so a nullable column in the PK would let duplicate untagged rows
-- accumulate silently and every count would be low. '' is a real value that
-- conflicts with itself, which is the whole point. Surfaced as "(untagged)".
--
-- ⚠️ org_id JOINS THE PK (R3). It was already a column but not part of the key,
-- which made this the one table in the feature relying on partner_key_id's
-- global uniqueness rather than on org scoping. Backfilled from the existing
-- rows (single-org today, and the column is already NOT NULL with an FK).
--
-- ADDITIVE for reads: existing rows gain interest_tag='' and keep their counts.

ALTER TABLE public.lead_intake_daily
  ADD COLUMN interest_tag text NOT NULL DEFAULT '';
--> statement-breakpoint

-- Existing rows predate the tag grain; '' is the honest value for them (their
-- counts are a mix of whatever tags were in play), and it keeps them addressable
-- rather than orphaning them under a guessed tag.
ALTER TABLE public.lead_intake_daily
  DROP CONSTRAINT lead_intake_daily_pkey;
--> statement-breakpoint

ALTER TABLE public.lead_intake_daily
  ADD CONSTRAINT lead_intake_daily_pkey
  PRIMARY KEY (org_id, partner_key_id, day_et, interest_tag);
--> statement-breakpoint

-- The report's scan: an org's rows over a day range, newest first. The old
-- (org_id, day_et DESC) index stays useful and is left alone.
CREATE INDEX lead_intake_daily_org_partner_tag_day_idx
  ON public.lead_intake_daily (org_id, partner_key_id, interest_tag, day_et DESC);
--> statement-breakpoint

-- RLS matches every other tenant table: enabled, SELECT-only, org-scoped.
-- Writes go through the intake transaction with the trusted org id, never
-- through an end-user session, so there is deliberately no write policy.
ALTER TABLE public.lead_intake_daily ENABLE ROW LEVEL SECURITY;
