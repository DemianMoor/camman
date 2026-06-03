-- TextHub send pipeline (Step 2 — non-sending pieces).
--
-- Adds the per-recipient send record (stage_sends), per-provider API
-- credentials, and an API-capable marker on sms_providers. No SMS is sent by
-- anything in this migration — these tables back the kickoff (materialize +
-- mint) and the later (Step 3, owner-gated) drain.

-- API-capable marker. A campaign stage can only do a tracked API send when its
-- provider has this on AND a provider_credentials row (enforced at kickoff).
ALTER TABLE public.sms_providers
  ADD COLUMN supports_api_send boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Per-provider API credentials. One api_key per provider.
--
-- ⚠️ SECURITY (conscious v1 tradeoff — see docs/security-notes.md): the api_key
-- is stored PLAINTEXT AT REST. It is protected by (a) RLS with NO policies
-- (deny-by-default — only the service-role/privileged DB connection can touch
-- the table; the anon/auth Supabase clients cannot), and (b) app-layer
-- permission checks on the management endpoint. The key is never sent to the
-- browser (the UI shows set/not-set only). Encryption-at-rest / a secrets
-- manager is a later hardening item.
CREATE TABLE public.provider_credentials (
  id          serial PRIMARY KEY,
  org_id      uuid    NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider_id integer NOT NULL UNIQUE REFERENCES public.sms_providers(id) ON DELETE CASCADE,
  api_key     text    NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX provider_credentials_org_id_idx ON public.provider_credentials (org_id);
--> statement-breakpoint

-- RLS deny-by-default: enable RLS but define NO policies, so only the
-- privileged DB role (which bypasses RLS) can read/write the secret. All
-- legitimate access goes through the app's server-side Drizzle connection with
-- app-layer permission checks.
ALTER TABLE public.provider_credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- One row per recipient-message. id IS the send_token fed to mintLink()'s
-- (stage_id, contact_id, send_token) idempotency key — a retry of a row reuses
-- its link; a genuine resend is a new run with new rows/tokens. No
-- (stage_id, contact_id) unique constraint, by design.
CREATE TABLE public.stage_sends (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid    NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id        integer NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  stage_id           integer NOT NULL REFERENCES public.campaign_stages(id) ON DELETE CASCADE,
  contact_id         uuid    NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  phone              text    NOT NULL,
  -- bigint: links.id is bigserial. NULL in manual mode (no minted link).
  link_id            bigint  REFERENCES public.links(id) ON DELETE SET NULL,
  -- Frozen at materialization so the sent body can't drift from the preview.
  rendered_text      text    NOT NULL,
  status             text    NOT NULL DEFAULT 'pending',
  -- TextHub's returned message id (set on send) — the handle for later DLR.
  texthub_message_id text,
  attempts           integer NOT NULL DEFAULT 0,
  last_error         text,
  lead_id            text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz,
  CONSTRAINT stage_sends_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'rejected'))
);
--> statement-breakpoint

CREATE INDEX stage_sends_org_id_idx ON public.stage_sends (org_id);
--> statement-breakpoint
CREATE INDEX stage_sends_stage_id_idx ON public.stage_sends (stage_id);
--> statement-breakpoint
CREATE INDEX stage_sends_link_id_idx ON public.stage_sends (link_id);
--> statement-breakpoint
-- Drain claim: find this stage's pending rows cheaply.
CREATE INDEX stage_sends_pending_idx ON public.stage_sends (stage_id) WHERE status = 'pending';
--> statement-breakpoint

-- RLS: org-scoped reads (status/reporting). Writes happen via the privileged
-- role (kickoff + drain), so no authenticated insert/update policy is needed.
ALTER TABLE public.stage_sends ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "stage_sends_select_own_org"
  ON public.stage_sends FOR SELECT
  USING (org_id = public.current_org_id());
