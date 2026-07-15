-- Ahoi Phase 1, Section 3 (DLR + CDR intake) — capture + reconcile tables.
--
-- G5: separate Ahoi-specific tables, mirroring texthub_inbound_events' shape
-- (migration 0055) rather than generalizing it.
--
-- Scope note: this migration creates the FULL column shape for
-- ahoi_inbound_events (including matched_contact_id/matched_stage_send_id/
-- result/processed_at) even though Section 3's code does not populate them —
-- Section 4 (opt-out intake) will UPDATE these existing columns rather than
-- needing its own migration, exactly mirroring how texthub_inbound_events'
-- 0055 pre-created its own "Stage B" columns ahead of the code that fills
-- them ("NOTHING here parses STOP... that is Stage B, built against the
-- captured payload shape").

-- DLR (delivery receipt) capture + reconcile. Deliberately NO uniqueness
-- constraint on provider_uuid: Ahoi sends TWO callbacks per message ~1s apart
-- (intermediate + final) plus EXTRA DLRs under numeric-only uuids for
-- multi-segment sends (Phase 0 recon) — all are legitimate distinct rows.
CREATE TABLE public.ahoi_dlr_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  credential_id         integer REFERENCES public.provider_credentials(id) ON DELETE SET NULL,
  provider_id           integer REFERENCES public.sms_providers(id) ON DELETE SET NULL,
  received_at           timestamptz NOT NULL DEFAULT now(),
  -- Exactly what arrived, captured verbatim (mirrors texthub_inbound_events).
  method                text NOT NULL,
  query                 jsonb,
  headers               jsonb,
  raw_body              text,
  -- Parsed via ahoiAdapter.parseDlr() at capture time. Section 3 does its own
  -- parse+reconcile in one request (unlike TextHub's deferred Stage A/B
  -- split) since a single-row uuid lookup is cheap.
  provider_uuid         text,
  source                text,
  destination           text,
  send_status           text,
  status                text,
  smpp_status           text,
  smpp_code             text,
  error                 text,
  -- Reconcile result: match provider_uuid -> stage_sends.texthub_message_id.
  -- NAMING DEBT: that column is named after TextHub but also holds Ahoi's
  -- send-time uuid since Section 2 — not renamed here (G2). See the comment
  -- at the match site in lib/sends/ahoi-dlr.ts.
  matched_stage_send_id uuid REFERENCES public.stage_sends(id) ON DELETE SET NULL,
  result                text,
  processed_at          timestamptz
);
--> statement-breakpoint

CREATE INDEX ahoi_dlr_events_org_id_idx ON public.ahoi_dlr_events (org_id);
--> statement-breakpoint
CREATE INDEX ahoi_dlr_events_received_at_idx ON public.ahoi_dlr_events (received_at);
--> statement-breakpoint
-- Serves the reject-rate circuit-breaker's rolling-window count
-- (lib/sends/circuit-breakers.ts countAhoiDlrRejectsSince).
CREATE INDEX ahoi_dlr_events_provider_reject_idx
  ON public.ahoi_dlr_events (provider_id, send_status, received_at);
--> statement-breakpoint

ALTER TABLE public.ahoi_dlr_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ahoi_dlr_events_select_own_org"
  ON public.ahoi_dlr_events FOR SELECT
  USING (org_id = public.current_org_id());
--> statement-breakpoint

-- Reconcile lookups (DLR provider_uuid -> stage_sends row by
-- texthub_message_id) need this index; any future TextHub DLR use would
-- share it too (same column, shared index — see the naming-debt note above).
--
-- stage_sends is LARGE (820K+ rows / ~490 MB in prod) and hot — a plain
-- CREATE INDEX would take an ACCESS EXCLUSIVE lock and block sends during
-- apply. So this index is built OUT-OF-BAND, CONCURRENTLY, by
-- scripts/apply-ahoi-stage-sends-index-concurrent.ts BEFORE `db:migrate`
-- runs (CONCURRENTLY cannot run inside drizzle's migration transaction).
-- The IF NOT EXISTS below then NO-OPS, leaving the migration recorded in the
-- chain. Same established pattern as migration 0101 (contacts_phone_number_idx)
-- / 0088 / 0096. The two CREATE TABLE statements above are brand-new EMPTY
-- tables — no lock risk, so they stay as normal in-migration statements.
CREATE INDEX IF NOT EXISTS stage_sends_texthub_message_id_idx
  ON public.stage_sends (texthub_message_id)
  WHERE texthub_message_id IS NOT NULL;
--> statement-breakpoint

-- Inbound (STOP / general reply) capture — TWO ingestion channels sharing one
-- table (G5): 'webhook' (real-time push, Task 6) and 'cdr' (the */15 poll
-- backstop, Task 7). CDR rows carry a real provider_uuid (plain 5-group hex,
-- Phase 0 recon) and are deduped by it; Ahoi's inbound WEBHOOK payload has NO
-- uuid field at all, so webhook rows leave provider_uuid NULL — the partial
-- unique index below therefore only ever constrains CDR rows.
CREATE TABLE public.ahoi_inbound_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  credential_id         integer REFERENCES public.provider_credentials(id) ON DELETE SET NULL,
  provider_id           integer REFERENCES public.sms_providers(id) ON DELETE SET NULL,
  source                text NOT NULL,  -- ingestion channel: 'webhook' | 'cdr'
  source_number         text,
  destination_number    text,
  message                text,
  type                  text,
  cost                  numeric(12, 4),
  provider_uuid         text,           -- CDR only; NULL for webhook rows
  received_at           timestamptz NOT NULL DEFAULT now(),
  method                text NOT NULL,
  raw_body              text,
  -- Section 4 (opt-out intake) fills these when it processes a captured row —
  -- pre-created here so Section 4 needs no migration of its own.
  matched_contact_id    uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  matched_stage_send_id uuid REFERENCES public.stage_sends(id) ON DELETE SET NULL,
  result                text,
  processed_at          timestamptz,
  CONSTRAINT ahoi_inbound_events_source_check CHECK (source IN ('webhook', 'cdr'))
);
--> statement-breakpoint

CREATE INDEX ahoi_inbound_events_org_id_idx ON public.ahoi_inbound_events (org_id);
--> statement-breakpoint
CREATE INDEX ahoi_inbound_events_received_at_idx ON public.ahoi_inbound_events (received_at);
--> statement-breakpoint
CREATE UNIQUE INDEX ahoi_inbound_events_provider_uuid_uniq
  ON public.ahoi_inbound_events (provider_id, provider_uuid)
  WHERE provider_uuid IS NOT NULL;
--> statement-breakpoint

ALTER TABLE public.ahoi_inbound_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ahoi_inbound_events_select_own_org"
  ON public.ahoi_inbound_events FOR SELECT
  USING (org_id = public.current_org_id());
