-- Migration 0119: per-campaign send breaker (P7/P8).
--
-- P8 blast-radius decision: the rolling opt-out-rate breaker (P7) pauses ONE
-- campaign, not the whole provider. This adds a latching kill-switch on the
-- campaign row (mirror of sms_providers.send_paused) plus a dedicated audit
-- table (send_circuit_events is provider-FK-only; we do NOT touch its
-- constraints). All additive/nullable — no table rewrite.
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS send_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS send_paused_reason text,
  ADD COLUMN IF NOT EXISTS send_paused_at timestamptz;

CREATE TABLE IF NOT EXISTS public.campaign_circuit_events (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id   integer NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  event         text NOT NULL,
  reason        text,
  actor_user_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_circuit_events_event_check CHECK (event IN ('paused', 'resumed'))
);
CREATE INDEX IF NOT EXISTS campaign_circuit_events_campaign_idx
  ON public.campaign_circuit_events (campaign_id, created_at);
CREATE INDEX IF NOT EXISTS campaign_circuit_events_org_id_idx
  ON public.campaign_circuit_events (org_id);
