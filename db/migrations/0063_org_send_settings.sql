-- Org-level operational settings + an audit trail for them. Workstream 1 of the
-- SMS-pipeline improvements brief: move the day-to-day live-sending on/off out of
-- the SEND_ENABLED env var (which stays permanently true in Vercel as a basement
-- breaker) and into a DB flag operators control from Settings without a redeploy.
--
-- org_settings is a per-org singleton (org_id PK). sends_enabled defaults FALSE
-- so a fresh org can never send until someone consciously turns it on. The
-- denormalized sends_enabled_updated_by/_at mirror the send_paused_reason/_at
-- pattern on sms_providers (cheap "who/when last changed" read); full history
-- lives in org_setting_events.
CREATE TABLE public.org_settings (
  org_id                   uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  sends_enabled            boolean NOT NULL DEFAULT false,
  sends_enabled_updated_by uuid,
  sends_enabled_updated_at timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Append-only audit of every settings flip (mirrors send_circuit_events). One
-- row per change: setting_key + old->new value + actor + when. actor_user_id is
-- the auth user id WITHOUT a cross-schema FK (the audit record must survive the
-- actor being deleted); NULL ⇒ system action.
CREATE TABLE public.org_setting_events (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  setting_key   text NOT NULL,
  old_value     text,
  new_value     text,
  actor_user_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX org_setting_events_org_id_idx
  ON public.org_setting_events (org_id, created_at);
--> statement-breakpoint

-- RLS: org-scoped reads (Settings UI shows current state). Writes go through the
-- app's privileged connection inside the mutation handler, so there is no
-- authenticated write policy (mirrors send_circuit_events / campaign_events).
ALTER TABLE public.org_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_settings_select_own_org"
  ON public.org_settings FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

ALTER TABLE public.org_setting_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_setting_events_select_own_org"
  ON public.org_setting_events FOR SELECT
  USING (org_id = public.current_org_id());
