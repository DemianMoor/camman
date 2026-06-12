-- Campaign activity log: append-only audit of meaningful actions on a campaign
-- and its stages (lifecycle status changes, stage authoring, the send pipeline
-- approve/kickoff/drain, and result imports). Powers the campaign Activity tab's
-- timeline. Individual per-recipient messages are NOT copied here — that
-- drill-down reads stage_sends live (see the campaign_id index added below).
--
-- event_type is intentionally free-text (no CHECK): the allowed set is
-- documented in lib/campaign-events.ts, so adding a new event kind never needs a
-- migration. actor_user_id is the auth user id WITHOUT a cross-schema FK (an
-- audit record must survive the actor being deleted); NULL ⇒ system/cron.
CREATE TABLE public.campaign_events (
  id            bigserial PRIMARY KEY,
  org_id        uuid    NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id   integer NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  stage_id      integer REFERENCES public.campaign_stages(id) ON DELETE SET NULL,
  event_type    text    NOT NULL,
  actor_user_id uuid,
  summary       text    NOT NULL,
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX campaign_events_campaign_idx
  ON public.campaign_events (campaign_id, created_at);
--> statement-breakpoint
CREATE INDEX campaign_events_org_id_idx ON public.campaign_events (org_id);
--> statement-breakpoint

-- RLS: org-scoped reads (timeline display). Writes happen via the app's
-- privileged connection inside the mutation handlers, so no authenticated write
-- policy (mirrors send_circuit_events in 0058).
ALTER TABLE public.campaign_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "campaign_events_select_own_org"
  ON public.campaign_events FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

-- Campaign-level activity drill-down lists this campaign's sends newest-first.
-- stage_sends previously had no campaign_id index (only org_id / stage_id).
CREATE INDEX stage_sends_campaign_created_idx
  ON public.stage_sends (campaign_id, created_at);
