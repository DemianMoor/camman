-- Tells.co webhook capture — the persist-first raw event log (Phase 1).
--
-- Design: docs/superpowers/specs/2026-08-12-tells-provider-design.md §6.
-- Verified payload contract: §5.1 (NOT §2 — §2 is the pre-probe claim and is
-- wrong in eight places).
--
-- Numbering note: the spec says "0129"; that number was taken by
-- 0129_segment_rules_sent_from_phone before this landed. This is 0130.
--
-- ONE table with a `kind` discriminator, deliberately unlike the two-table
-- ahoi_*/textrequest_* pattern. Tells has NO replay and NO reconciliation API
-- of any kind, so this table is not a log alongside a recoverable source — it
-- IS the only copy. The handler therefore does one thing: commit a row.
-- Parsing, reconcile and opt-out suppression run afterwards (inline
-- best-effort, then swept by cron over processed_at IS NULL) and are always
-- retryable.
--
-- Phase 0 established that Tells DOES retry a non-2xx callback (4 attempts,
-- 60s apart, ~3 min) and then abandons the message's REMAINING statuses too.
-- So duplicates are guaranteed in normal operation whenever we fail, which is
-- what makes the dedup index below load-bearing rather than precautionary.
CREATE TABLE public.tells_webhook_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  credential_id         integer REFERENCES public.provider_credentials(id) ON DELETE SET NULL,
  provider_id           integer REFERENCES public.sms_providers(id) ON DELETE SET NULL,
  -- Which route received it. 'dlr' = status webhook, 'inbound' = reply webhook.
  kind                  text NOT NULL,
  received_at           timestamptz NOT NULL DEFAULT now(),

  -- Verbatim capture (house pattern: ahoi_dlr_events, textrequest_dlr_events).
  --
  -- ⚠️ ONE EXCEPTION, enforced in code, not here (spec §4.6): the INBOUND body
  -- carries the FULL LIVE TELLS API KEY in its `Key` field. That field's value
  -- MUST be replaced with a marker before the row is written. Everything else
  -- is byte-for-byte. A credential in this column would be replicated into
  -- every backup and export — CLAUDE.md §11.
  method                text NOT NULL,
  query                 jsonb,
  headers               jsonb,
  raw_body              text,

  -- Minimal addressing fields, extracted in a guarded try/catch at capture.
  -- NOT processing: a handful of string reads so the sweeper's queries and the
  -- dedup key are cheap. If extraction throws, every column here stays NULL and
  -- the row still lands — raw_body is the source of truth.
  --
  -- ⚠️ Id/To/From arrive as JSON NUMBERS on the webhooks but as STRINGS on the
  -- send response (§5.1). Coerce to text on the way in or correlation silently
  -- never matches.
  provider_message_id   text,   -- DLR: Id
  status                text,   -- DLR: sent | delivered | undelivered
  error_message         text,   -- DLR: ErrorMessage (present even on success: "No error.")
  from_number           text,   -- payload From, verbatim wire format
  to_number             text,   -- payload To, verbatim wire format
  body                  text,   -- inbound: Body
  -- DLR: `metadata`, echoed verbatim, carries stage_send_id.
  -- ⚠️ LOWERCASE on the wire — the only lowercase field on an otherwise
  -- PascalCase DLR. Always present (null when unset), and ALWAYS a string even
  -- when a JSON object was sent.
  metadata_raw          text,
  -- Date/Timezone stored as TEXT verbatim, never cast at capture. Phase 0
  -- verified Tells's "UTC" claim IS truthful (unlike TextHub, which claimed UTC
  -- and sent Mountain), so this is a cheap safety net rather than a fix. Two
  -- formats in play: 'Z' on DLRs, '+00:00' on inbound.
  --
  -- ⚠️ Date is the delivery-ATTEMPT timestamp, not the status-transition time —
  -- it advances on every retry. It must NEVER enter a dedup key.
  provider_date         text,
  provider_timezone     text,

  -- Idempotency key, computed in TS at capture:
  --   dlr     -> 'dlr:' || Id || ':' || Status
  --   inbound -> 'in:'  || From || ':' || To || ':' || sha256(Body) || ':' || Date
  -- NULL when extraction failed. Capture upserts against the partial unique
  -- index below, so a replayed event is a counter bump, never an error — an
  -- INSERT that can fail is an event that can be lost.
  dedup_key             text,

  -- Duplicate deliveries bump these instead of creating a row. Non-zero means
  -- either we returned a non-2xx (Tells retried) or we replayed deliberately.
  -- Surfaced in the weekly runbook; the ON CONFLICT DO UPDATE touches ONLY
  -- these two columns, never the processing state below. Never alerts.
  duplicate_count       integer NOT NULL DEFAULT 0,
  last_duplicate_at     timestamptz,

  -- Filled by the processor (inline attempt, or the cron sweeper).
  matched_stage_send_id uuid REFERENCES public.stage_sends(id) ON DELETE SET NULL,
  matched_contact_id    uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  result                text,
  processed_at          timestamptz,
  process_attempts      integer NOT NULL DEFAULT 0,
  process_error         text,

  CONSTRAINT tells_webhook_events_kind_check CHECK (kind IN ('dlr', 'inbound'))
);
--> statement-breakpoint
CREATE INDEX tells_webhook_events_org_id_idx ON public.tells_webhook_events (org_id);
--> statement-breakpoint
CREATE INDEX tells_webhook_events_received_at_idx ON public.tells_webhook_events (received_at);
--> statement-breakpoint
-- The sweeper's work queue. Partial so it stays tiny regardless of table size.
CREATE INDEX tells_webhook_events_unprocessed_idx
  ON public.tells_webhook_events (received_at)
  WHERE processed_at IS NULL;
--> statement-breakpoint
-- Idempotent capture: a redelivery (or our own replay off this table) collapses
-- to a counter bump. Partial so extraction failures (dedup_key NULL) always
-- land as distinct rows rather than colliding.
CREATE UNIQUE INDEX tells_webhook_events_dedup_uniq
  ON public.tells_webhook_events (provider_id, dedup_key)
  WHERE dedup_key IS NOT NULL;
--> statement-breakpoint
-- DLR coverage / silence monitor + a future delivery-failure breaker
-- (mirrors ahoi_dlr_events_provider_reject_idx). NOTE for the monitor: a
-- SUCCESSFUL message emits 2 rows (sent, delivered), a FAILED one emits 1
-- (undelivered, with no preceding sent) — see spec §4.5.
CREATE INDEX tells_webhook_events_provider_status_idx
  ON public.tells_webhook_events (provider_id, kind, status, received_at);
--> statement-breakpoint
-- Inbound dedup window by contact number (mirrors textrequest_inbound_events_dedup_idx).
CREATE INDEX tells_webhook_events_from_number_idx
  ON public.tells_webhook_events (org_id, from_number, received_at)
  WHERE kind = 'inbound';
--> statement-breakpoint
ALTER TABLE public.tells_webhook_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tells_webhook_events_select_own_org"
  ON public.tells_webhook_events FOR SELECT
  USING (org_id = public.current_org_id());
