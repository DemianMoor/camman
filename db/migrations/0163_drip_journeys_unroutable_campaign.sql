-- Migration 0163: allow drip_journeys.campaign_id to be NULL for 'unroutable'
-- (Drip Phase 4 correction).
--
-- ⚠️ WHY THIS IS A SEPARATE MIGRATION RATHER THAN AN EDIT TO 0161.
-- 0161 is already applied to production, so its file is frozen — editing it
-- would break verify-migration-integrity's hash check for everyone. The fix
-- goes forward.
--
-- THE DEFECT. 0161 declared campaign_id NOT NULL, which is right for a real
-- journey: a routed lead is routed TO something. But the spec also requires that
-- a lead which matches NOTHING for the whole TTL be "marked unroutable with
-- reason" — and such a lead, by definition, has no campaign. NOT NULL forced the
-- worker to pick an arbitrary drip campaign to point at, which would have
-- recorded a journey against a campaign that never wanted the lead: wrong on the
-- campaign's journey count, wrong in the UI, and actively misleading in the
-- "why not routed" tool, which is the one place an operator goes for the truth.
--
-- THE FIX. campaign_id becomes nullable, and a CHECK keeps it mandatory for
-- every state EXCEPT 'unroutable'. So the invariant that a real journey always
-- names its campaign is preserved by the database, while an unroutable marker is
-- allowed to name none.
--
-- The one-live-journey partial unique is unaffected: 'unroutable' is not in
-- ('routed','active'), so an unroutable marker never blocks a later real routing
-- — which is exactly what the 7-day TTL wants, since it is aligned with the
-- >1-week re-entry rule.
--
-- ADDITIVE in effect: every existing row has a non-null campaign_id and a
-- non-unroutable state, so both directions of the CHECK already hold.

ALTER TABLE public.drip_journeys
  ALTER COLUMN campaign_id DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE public.drip_journeys
  ADD CONSTRAINT drip_journeys_campaign_required_check
  CHECK (state = 'unroutable' OR campaign_id IS NOT NULL);
