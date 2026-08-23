-- Migration 0156: lead_events — one row per lead that became a contact
-- (Drip Phase 3).
--
-- This is the per-arrival ledger. `contacts` says a person exists; `lead_events`
-- says WHEN they arrived, FROM WHOM, and under WHICH interest tag — which is
-- what the spec's "existing contact arriving as a coreg lead is a new drip lead
-- only if it has been in the system > 1 week" rule reads, and what Phase 7
-- reports per partner.
--
-- ⚠️ inbox_id is ON DELETE SET NULL, NOT CASCADE. Landline leads are counted and
-- then REMOVED from lead_inbox (ruled), and a cascading FK would take the lead
-- event with it — deleting the very evidence the row exists to preserve. SET
-- NULL keeps the event and forgets only the pointer.
--
-- ⚠️ The partial UNIQUE on inbox_id is what makes the sweeper safely re-runnable.
-- A crash between "write the event" and "mark the inbox row processed" is
-- normal, not exceptional: the next pass re-reads a 'received' row and would
-- write a second event for the same arrival. ON CONFLICT DO NOTHING against
-- this index makes the replay a no-op. It is partial because a landline lead's
-- inbox_id is nulled later and several NULLs must coexist.
--
-- line_type is stamped here per ruling G19: voip and unknown are saved and
-- processed exactly like mobile (matching the existing policy that
-- lib/telnyx/map-line-type.ts states explicitly — "we never silently suppress a
-- number we're unsure about"), so Phase 4 can filter per campaign if wanted
-- rather than the decision being made irreversibly at intake.
--
-- ADDITIVE. New table only.

CREATE TABLE public.lead_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id     uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  partner_key_id integer NOT NULL REFERENCES public.partner_keys(id) ON DELETE RESTRICT,
  -- Denormalized, same reasoning as lead_inbox.partner_slug: provenance must
  -- survive the key being renamed.
  partner_slug   text NOT NULL,
  interest_tag   text,
  -- The PARTNER's arrival time (lead_inbox.received_at), not when we processed
  -- it. The >1-week re-qualification rule is about when the lead arrived.
  received_at    timestamptz NOT NULL,
  inbox_id       uuid REFERENCES public.lead_inbox(id) ON DELETE SET NULL,
  sandbox        boolean NOT NULL DEFAULT false,
  line_type      text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Idempotent replay: one event per captured lead.
CREATE UNIQUE INDEX lead_events_inbox_uniq
  ON public.lead_events (inbox_id)
  WHERE inbox_id IS NOT NULL;
--> statement-breakpoint

-- "Has this contact arrived before, and how long ago?" — the >1-week rule.
CREATE INDEX lead_events_org_contact_received_idx
  ON public.lead_events (org_id, contact_id, received_at DESC);
--> statement-breakpoint

-- Phase 7 per-partner reporting.
CREATE INDEX lead_events_org_partner_received_idx
  ON public.lead_events (org_id, partner_key_id, received_at DESC);
--> statement-breakpoint

ALTER TABLE public.lead_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "lead_events_select_own_org"
  ON public.lead_events FOR SELECT
  USING (org_id = public.current_org_id());
