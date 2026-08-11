-- Text Request Phase 3 (DLR intake) — per-message status_callback capture +
-- reconcile table. Mirrors ahoi_dlr_events (migration 0109) but for TR's JSON
-- callback shape: no smpp_* fields; a `message_id` (GUID) + `status` + optional
-- `error_code`, plus `stage_send_id` captured DIRECTLY from the callback URL's
-- ?ss=<stage_send_id> (TR's standout advantage — no uuid-guessing like Ahoi).
--
-- No uniqueness on message_id: TR may POST more than one callback per message
-- (e.g. intermediate + final delivery states) — all are legitimate rows.
CREATE TABLE public.textrequest_dlr_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  credential_id         integer REFERENCES public.provider_credentials(id) ON DELETE SET NULL,
  provider_id           integer REFERENCES public.sms_providers(id) ON DELETE SET NULL,
  received_at           timestamptz NOT NULL DEFAULT now(),
  -- Verbatim capture (mirrors ahoi_dlr_events / texthub_inbound_events).
  method                text NOT NULL,
  query                 jsonb,
  headers               jsonb,
  raw_body              text,
  -- Parsed from TR's JSON callback body { message_id, status, errorCode }.
  message_id            text,
  status                text,
  error_code            text,
  -- stage_send_id from the callback URL ?ss= param (direct reconcile key).
  stage_send_id         uuid REFERENCES public.stage_sends(id) ON DELETE SET NULL,
  -- Reconcile result: resolved stage_send (by ?ss= first, else message_id ->
  -- stage_sends.texthub_message_id) + outcome.
  matched_stage_send_id uuid REFERENCES public.stage_sends(id) ON DELETE SET NULL,
  result                text,
  processed_at          timestamptz
);
--> statement-breakpoint
CREATE INDEX textrequest_dlr_events_org_id_idx ON public.textrequest_dlr_events (org_id);
--> statement-breakpoint
CREATE INDEX textrequest_dlr_events_received_at_idx ON public.textrequest_dlr_events (received_at);
--> statement-breakpoint
-- Serves a future per-provider delivery-failure-rate breaker (mirrors
-- ahoi_dlr_events_provider_reject_idx).
CREATE INDEX textrequest_dlr_events_provider_status_idx
  ON public.textrequest_dlr_events (provider_id, status, received_at);
--> statement-breakpoint
ALTER TABLE public.textrequest_dlr_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "textrequest_dlr_events_select_own_org"
  ON public.textrequest_dlr_events FOR SELECT
  USING (org_id = public.current_org_id());
