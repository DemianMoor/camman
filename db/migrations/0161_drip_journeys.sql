-- Migration 0161: drip_journeys — one lead's assignment to exactly one drip
-- campaign (Drip Phase 4).
--
-- ⭐ THE PARTIAL UNIQUE ON (org_id, contact_id) IS THE POINT OF THIS MIGRATION.
--
-- "A lead is routed to exactly ONE campaign" is the central rule of the drip
-- spec. Everything else in the routing worker — tag match, filters, priority,
-- tie-break — is POLICY, and policy lives in code that can be raced, retried, or
-- called twice. This index makes one-campaign-only an INVARIANT the database
-- enforces: two concurrent ticks, a retry after a timeout, or some future second
-- caller cannot produce two live journeys for one contact, because the second
-- insert is refused.
--
-- The routing code therefore treats a unique violation (23505) as "lost the
-- race, skip this lead" — not as an error. That is the whole contract: the
-- worker may be optimistic precisely because the index is pessimistic.
--
-- It is PARTIAL on the live states so a contact who completed or exited a
-- journey can be routed again later — which the >1-week re-entry rule requires.
--
-- ⚠️ UNIQUE (lead_event_id) is a second, different idempotency guarantee: it
-- makes re-processing the SAME ARRIVAL a no-op, the same crash-safety trick
-- lead_events.inbox_id uses for the enrichment sweeper. The two constraints
-- answer different questions — "is this contact already in a campaign?" versus
-- "have I already routed this specific arrival?" — and both are needed.
--
-- `reason` is not decoration. It records WHY this campaign won and what was
-- skipped, and it is what the "why not routed" debugging tool reads when an
-- operator asks why a partner's lead did not go anywhere. In Phase 4 it also
-- carries creative_check: "deferred_p5" — the creative half of the
-- same-offer-same-creative rule has no operand until drip stages exist, and
-- recording that explicitly is better than shipping a rule that silently passes
-- everything and looks implemented.
--
-- ADDITIVE. New table only.

CREATE TABLE public.drip_journeys (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id    integer NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  contact_id     uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  lead_event_id  uuid NOT NULL REFERENCES public.lead_events(id) ON DELETE CASCADE,

  state          text NOT NULL DEFAULT 'routed',
  routed_at      timestamptz NOT NULL DEFAULT now(),
  reason         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT drip_journeys_state_check
    CHECK (state IN ('routed', 'active', 'completed', 'exited', 'unroutable'))
);
--> statement-breakpoint

-- Idempotent replay: one journey per arrival.
CREATE UNIQUE INDEX drip_journeys_lead_event_uniq
  ON public.drip_journeys (lead_event_id);
--> statement-breakpoint

-- ⭐ ONE LIVE CAMPAIGN PER CONTACT. Partial, so a completed or exited journey
-- frees the contact for re-entry.
CREATE UNIQUE INDEX drip_journeys_one_live_per_contact_uniq
  ON public.drip_journeys (org_id, contact_id)
  WHERE state IN ('routed', 'active');
--> statement-breakpoint

-- Cap counting: journeys per campaign per state.
CREATE INDEX drip_journeys_org_campaign_state_idx
  ON public.drip_journeys (org_id, campaign_id, state);
--> statement-breakpoint

-- The worker's scan and the campaign-detail "recent journeys" list.
CREATE INDEX drip_journeys_org_state_routed_idx
  ON public.drip_journeys (org_id, state, routed_at DESC);
--> statement-breakpoint

-- The "why not routed" lookup goes contact -> journeys.
CREATE INDEX drip_journeys_org_contact_idx
  ON public.drip_journeys (org_id, contact_id, routed_at DESC);
--> statement-breakpoint

ALTER TABLE public.drip_journeys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "drip_journeys_select_own_org"
  ON public.drip_journeys FOR SELECT
  USING (org_id = public.current_org_id());
