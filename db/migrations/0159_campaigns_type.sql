-- Migration 0159: campaigns.type (Drip Phase 4).
--
-- The one and only column this phase adds to `campaigns`. Everything else drip
-- needs lives in the 1:1 drip_campaign_configs table (0160), deliberately: the
-- claim this phase has to prove is "regular campaigns are unaffected", and that
-- claim is only provable if the disturbance is small enough to enumerate. One
-- column is enumerable; thirteen nullable ones are not.
--
-- ⚠️ NOT NULL DEFAULT 'regular' — the fail-safe DIRECTION matters.
-- All 295 existing rows become 'regular' with no backfill, and more importantly
-- a missing, unknown or unreadable type can never be read as 'drip'. That is the
-- same direction R13 mandates for the opt-out breaker: only a positive,
-- successful read of 'drip' may take the new path; everything else keeps
-- existing behaviour.
--
-- ⚠️ CALLERS THAT BUILD AN EXPLICIT VALUES() LITERAL MUST CARRY THIS COLUMN.
-- app/api/campaigns/[campaignId]/duplicate/route.ts inserts field-by-field
-- rather than spreading the source row, so without an explicit addition there it
-- would silently take the default and turn a duplicated DRIP campaign into a
-- REGULAR one — a 200, a success toast, and the wrong data. That route is
-- updated in the same PR and asserted by a test.
--
-- ADDITIVE. No backfill, no data change.

ALTER TABLE public.campaigns
  ADD COLUMN type text NOT NULL DEFAULT 'regular';
--> statement-breakpoint

ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_type_check CHECK (type IN ('regular', 'drip'));
--> statement-breakpoint

-- The routing worker's scan: "active drip campaigns for this org".
CREATE INDEX campaigns_org_type_status_idx
  ON public.campaigns (org_id, type, status);
