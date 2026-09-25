-- Migration 0191: offer cooldown + offer limit on campaigns (869f53efz, PR 4d).
--
-- Replaces "this contact ever got this offer, so never again" with two numbers
-- an operator controls: not within Y days, and not more than N times.
--
--   offer_cooldown_days  Y. A contact is excluded while their last send of this
--                        offer is MORE RECENT than now() - Y days. Exactly Y
--                        days ago is INSIDE the cooldown (owner, 2026-09-25) --
--                        the same `>` the freeze cadence uses, so two cadence
--                        rules in one codebase cannot have opposite boundaries.
--   offer_limit_times    N. Counts CAMPAIGNS, not messages (owner, 2026-09-25):
--                        one sequence = 1 however many stages it has. The layer
--                        reads count(*) over contact_offer_campaigns rows, never
--                        sum(messages).
--   offer_rules_enabled  WHICH SEMANTICS apply when the campaign's existing
--                        exclude_prior_offer_contacts toggle is on:
--                          true  -> the Y/N rule
--                          false -> the legacy "ever got this offer"
--
-- ── WHY offer_rules_enabled DEFAULTS TO FALSE ──────────────────────────────
-- The card says the toggle is "on by default for new campaigns", and it is --
-- but that default is written by the CREATE ROUTE, not by this column.
--
-- A `DEFAULT true` here converts all 673 existing campaigns the instant this
-- migration lands, including ACTIVE ones whose audience pools are already
-- frozen. Their exclude_prior_offer_contacts would silently stop meaning "ever
-- got" and start meaning "not within 7 days / not more than 5 times", changing
-- who their remaining stages reach, with no operator action and nothing in any
-- audit trail. A column default cannot distinguish "new campaign" from "every
-- row that already exists"; a route can.
--
-- So: existing campaigns keep exactly what they had, and only campaigns created
-- after PR 4d deploys get the new semantics.
--
-- ── SHAPE ──────────────────────────────────────────────────────────────────
-- All three are NOT NULL with CONSTANT defaults, so each ADD COLUMN is
-- metadata-only on PG 11+ (the value lands in pg_attribute.attmissingval and no
-- row is rewritten). campaigns is a 673-row table where a rewrite would cost
-- nothing measurable, but the habit is what keeps the next one on a big table
-- safe.
--
-- The bounds checks are ADD ... NOT VALID then VALIDATE, per 0187's standing
-- instruction and 0188/0190's practice: NOT VALID is catalog-only and instant
-- while still enforcing on every INSERT and UPDATE from that moment, and
-- VALIDATE takes SHARE UPDATE EXCLUSIVE rather than ACCESS EXCLUSIVE. On 673
-- rows either would be imperceptible; doing it the same way every time is how
-- the pattern survives contact with a table where it matters.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS offer_cooldown_days integer NOT NULL DEFAULT 7;
--> statement-breakpoint
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS offer_limit_times integer NOT NULL DEFAULT 5;
--> statement-breakpoint
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS offer_rules_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE public.campaigns
  DROP CONSTRAINT IF EXISTS campaigns_offer_cooldown_days_check;
--> statement-breakpoint
ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_offer_cooldown_days_check
  CHECK (offer_cooldown_days BETWEEN 0 AND 365)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.campaigns
  DROP CONSTRAINT IF EXISTS campaigns_offer_limit_times_check;
--> statement-breakpoint
ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_offer_limit_times_check
  CHECK (offer_limit_times BETWEEN 1 AND 100)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.campaigns VALIDATE CONSTRAINT campaigns_offer_cooldown_days_check;
--> statement-breakpoint
ALTER TABLE public.campaigns VALIDATE CONSTRAINT campaigns_offer_limit_times_check;
