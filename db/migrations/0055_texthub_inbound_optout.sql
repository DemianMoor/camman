-- Inbound opt-out (STOP) intake — Stage A: capture + registration plumbing.
--
-- Adds (1) a per-credential webhook token used to BOTH authenticate the public
-- TextHub callback AND resolve an inbound call to its org, and (2) an
-- append-only raw-event log that captures exactly what TextHub delivers.
--
-- NOTHING here parses STOP or suppresses a contact — that is Stage B, built
-- against the captured payload shape (the TextHub callback contract is not in
-- the repo, so its shape is being confirmed by a live STOP capture first).

-- Per-credential secret embedded in the registered callback URL path. Lets the
-- public webhook map an inbound call -> (org, provider, brand) and reject
-- forged calls. NULL until the callback is registered for that key.
ALTER TABLE public.provider_credentials
  ADD COLUMN inbound_webhook_token text;
--> statement-breakpoint

-- Tokens are globally unique so a single inbound lookup resolves exactly one
-- credential. Partial (NULL coexists for unregistered keys).
CREATE UNIQUE INDEX provider_credentials_inbound_token_uniq
  ON public.provider_credentials (inbound_webhook_token)
  WHERE inbound_webhook_token IS NOT NULL;
--> statement-breakpoint

-- Append-only capture of every authenticated inbound TextHub callback. In
-- Stage A this is write-and-inspect (the live STOP capture). Stage B reads
-- provider_message_id for idempotency and fills processed_at / result /
-- matched_contact_id when it parses + suppresses.
CREATE TABLE public.texthub_inbound_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid    NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  credential_id       integer REFERENCES public.provider_credentials(id) ON DELETE SET NULL,
  provider_id         integer REFERENCES public.sms_providers(id) ON DELETE SET NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  -- Exactly what arrived, captured verbatim so the payload contract can be read
  -- off real data rather than guessed.
  method              text    NOT NULL,
  query               jsonb,
  headers             jsonb,
  raw_body            text,
  -- Filled by Stage B (nullable here):
  provider_message_id text,
  matched_contact_id  uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  result              text,
  processed_at        timestamptz
);
--> statement-breakpoint

CREATE INDEX texthub_inbound_events_org_id_idx
  ON public.texthub_inbound_events (org_id);
--> statement-breakpoint
CREATE INDEX texthub_inbound_events_received_at_idx
  ON public.texthub_inbound_events (received_at);
--> statement-breakpoint

-- RLS: org-scoped reads (an admin inspecting captured events). All writes go
-- through the privileged role (the public webhook), so no insert/update policy
-- is needed — deny-by-default for the authenticated Supabase clients.
ALTER TABLE public.texthub_inbound_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "texthub_inbound_events_select_own_org"
  ON public.texthub_inbound_events FOR SELECT
  USING (org_id = public.current_org_id());
