-- Migration 0166: record a journey's first send (Drip Phase 5).
--
-- A journey is 'routed' when the router assigns it and 'active' once its
-- first-send has actually been inserted. Phase 4 could not record WHICH stage
-- sent it or WHEN, because stages did not exist yet.
--
-- ⚠️ WHY THIS IS NEEDED RATHER THAN DERIVED. "Has this journey had its first
-- send?" could in principle be answered by looking for a stage_sends row with
-- the same (campaign_id, contact_id). It must not be:
--
--   * stage_sends is the table the RETENTION card will start deleting from in
--     September (>180 days). A journey's own history must not evaporate when the
--     message rows age out.
--   * the spec's rule is "exactly ONE first-send per lead". Deriving that from a
--     table that also holds behavioural follow-ups (Phase 6) would make the
--     count wrong the moment follow-ups land.
--
-- Recording it on the journey makes the first-send a fact about the JOURNEY,
-- which is what the rule is actually about.
--
-- first_send_id is deliberately NOT a foreign key to stage_sends, for the same
-- retention reason: an FK would either block the delete or null the column, and
-- the whole point is that this survives. It is an id kept for correlation while
-- the row exists.
--
-- ADDITIVE. All nullable, NULL on every existing row.

ALTER TABLE public.drip_journeys
  ADD COLUMN first_stage_id integer REFERENCES public.campaign_stages(id) ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE public.drip_journeys
  ADD COLUMN first_send_at timestamptz;
--> statement-breakpoint

-- Correlation only. No FK — see the header.
ALTER TABLE public.drip_journeys
  ADD COLUMN first_send_id uuid;
--> statement-breakpoint

-- A journey in a live state that has ALREADY had its first send must not get a
-- second one. The scheduler's due-scan reads exactly this.
CREATE INDEX drip_journeys_due_idx
  ON public.drip_journeys (org_id, campaign_id, routed_at)
  WHERE state = 'routed' AND first_send_at IS NULL;
--> statement-breakpoint

-- ⚠️ 'active' means "first send has happened", so the two must agree. A journey
-- cannot be active without a first_send_at, and cannot carry a first_send_at
-- while still merely 'routed' — either would let the due-scan hand the same lead
-- a second first-send.
ALTER TABLE public.drip_journeys
  ADD CONSTRAINT drip_journeys_first_send_state_check CHECK (
    (state = 'routed'      AND first_send_at IS NULL)
    OR (state <> 'routed')
  );
