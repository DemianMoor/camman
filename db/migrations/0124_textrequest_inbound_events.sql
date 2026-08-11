-- Text Request Phase 4 (opt-out intake) — inbound/opt-out signal capture.
--
-- Mirrors ahoi_inbound_events (migration 0109) but records FOUR structurally
-- different signals that all assert the same fact ("this number must not be
-- texted"), discriminated by `source`:
--
--   webhook_msg_received     account webhook, event msg_received — a STOP reply
--                            (payload: conversation.message / .consumerPhoneNumber)
--   webhook_contact_updated  account webhook, event contact_updated — Text
--                            Request's own opt-out bookkeeping (opted_out_utc /
--                            is_suppressed), which also covers STOPs TR handled
--                            itself and portal-side suppressions
--   poll_messages            messages poll, inbound (message_direction='R') rows
--                            — backstop for a lost/disconnected msg_received hook
--   poll_contacts            contacts poll (has_opted_out=true) — backstop for a
--                            lost/disconnected contact_updated hook
--   dlr                      delivery status carrying errorCode 2100 ("contact has
--                            previously opted out")
--   send_reject              POST /messages rejected with errorCode 30050 (same
--                            fact, observed at send time)
--
-- provider_uuid holds Text Request's message GUID (messageUniqueIdentifier on the
-- webhook, message_id in the messages list) — the SAME value on both channels for
-- the same physical message. The partial unique index therefore makes capture
-- idempotent ACROSS channels: the poll cannot re-write a STOP the webhook already
-- captured. (Ahoi could not do this — its webhook payload carries no uuid, which
-- is why it needs the message-text dedup window.) Contact-shaped signals have no
-- message GUID and so carry NULL here; multiple NULLs coexist by design, and the
-- opt-out processor's window dedup + already-opted-out check cover them.
CREATE TABLE public.textrequest_inbound_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  credential_id         integer REFERENCES public.provider_credentials(id) ON DELETE SET NULL,
  provider_id           integer REFERENCES public.sms_providers(id) ON DELETE SET NULL,
  -- Ingestion channel (see the list above) — NOT a phone number.
  source                text NOT NULL,
  -- The CONTACT's number as Text Request sends it (11-digit, no '+').
  source_number         text,
  -- Our dashboard's sending number, when the signal carries it.
  destination_number    text,
  -- STOP text for message-shaped signals; NULL for contact/DLR/send signals.
  message               text,
  -- Text Request's message GUID (see the note above).
  provider_uuid         text,
  -- TR's own opt-out timestamp, when the signal carries it (contact signals).
  opted_out_utc         timestamptz,
  received_at           timestamptz NOT NULL DEFAULT now(),
  method                text NOT NULL,
  raw_body              text,
  -- Filled by the opt-out processor.
  matched_contact_id    uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  matched_stage_send_id uuid REFERENCES public.stage_sends(id) ON DELETE SET NULL,
  -- 'ignored' | 'invalid_phone' | 'duplicate' | 'already_opted_out' | 'suppressed'
  result                text,
  processed_at          timestamptz
);
--> statement-breakpoint
CREATE INDEX textrequest_inbound_events_org_id_idx ON public.textrequest_inbound_events (org_id);
--> statement-breakpoint
CREATE INDEX textrequest_inbound_events_received_at_idx ON public.textrequest_inbound_events (received_at);
--> statement-breakpoint
-- Serves the cross-channel dedup lookup: (org, contact number, time window).
CREATE INDEX textrequest_inbound_events_dedup_idx
  ON public.textrequest_inbound_events (org_id, source_number, received_at);
--> statement-breakpoint
-- Idempotent capture for message-shaped signals (webhook and poll share the GUID).
CREATE UNIQUE INDEX textrequest_inbound_events_provider_uuid_uniq
  ON public.textrequest_inbound_events (provider_id, provider_uuid)
  WHERE provider_uuid IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.textrequest_inbound_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "textrequest_inbound_events_select_own_org"
  ON public.textrequest_inbound_events FOR SELECT
  USING (org_id = public.current_org_id());
