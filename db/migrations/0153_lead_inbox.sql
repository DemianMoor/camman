-- Migration 0153: lead_inbox — the raw partner-lead capture table (Drip Phase 2).
--
-- Step 4 of the Q7 webhook pattern: ONE committed INSERT carrying a dedup key,
-- then return. No lookups, no contacts, no sends, no inline processing. Phase 3
-- supplies the consumer; until then `status = 'received'` IS the queue.
--
-- ⚠️ dedup_key IS NULLABLE, WITH A PARTIAL UNIQUE INDEX — deliberately NOT the
-- `NOT NULL UNIQUE` the brief first specified (ruled G17).
--
-- The dedup key is (partner_key_id, phone, received_minute), and `phone` is
-- precisely the field that can be missing or unparseable in a partner payload.
-- A NOT NULL column would make a malformed lead IMPOSSIBLE TO INSERT — the
-- intake would reject exactly the leads most worth capturing, inverting the
-- whole "capture raw, decide later" design this table exists for. Phone-less
-- leads are therefore STORED with status='rejected' and a populated `error`,
-- so they are visible and countable rather than silently dropped at the edge.
--
-- This is the same shape tells_webhook_events already uses:
--   ON CONFLICT (provider_id, dedup_key) WHERE dedup_key IS NOT NULL
--
-- ⚠️ partner_slug is DENORMALIZED on purpose, and the FK is ON DELETE RESTRICT.
-- A lead's provenance must survive its key being renamed, and deleting a key
-- with leads behind it must fail loudly rather than orphan or cascade them. The
-- UI offers DISABLE, not delete — the same reasoning as no-DELETE on landing
-- pages in 1b, where a SET NULL would have silently changed behaviour.
--
-- ADDITIVE. New table only.

CREATE TABLE public.lead_inbox (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  partner_key_id integer NOT NULL REFERENCES public.partner_keys(id) ON DELETE RESTRICT,
  -- Denormalized: survives a rename or disable of the key above.
  partner_slug   text NOT NULL,

  received_at    timestamptz NOT NULL DEFAULT now(),

  -- The partner's payload as received, with the secret already redacted. Never
  -- the transport secret: it travels in a header (G12), so it is structurally
  -- absent from this column rather than removed by a string edit.
  raw            jsonb NOT NULL,
  -- NULL until Phase 3's enrichment worker fills it. Phase 2 normalizes nothing.
  normalized     jsonb,

  phone_e164     text,
  interest_tag   text,
  sandbox        boolean NOT NULL DEFAULT false,

  status         text NOT NULL DEFAULT 'received',
  processed_at   timestamptz,
  error          text,

  -- Nullable by design — see the header note.
  dedup_key      text,

  CONSTRAINT lead_inbox_status_check
    CHECK (status IN ('received', 'processed', 'rejected', 'landline', 'duplicate'))
);
--> statement-breakpoint

-- Partial unique: duplicates collapse per key, while a lead with no derivable
-- dedup key is still stored.
CREATE UNIQUE INDEX lead_inbox_dedup_uniq
  ON public.lead_inbox (partner_key_id, dedup_key)
  WHERE dedup_key IS NOT NULL;
--> statement-breakpoint

-- The Phase 3 worker's queue scan: oldest unprocessed first.
CREATE INDEX lead_inbox_status_received_idx ON public.lead_inbox (status, received_at);
--> statement-breakpoint

-- Per-partner reporting (Phase 7) and the intake UI's recent-activity panel.
CREATE INDEX lead_inbox_org_partner_received_idx
  ON public.lead_inbox (org_id, partner_key_id, received_at DESC);
--> statement-breakpoint

ALTER TABLE public.lead_inbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "lead_inbox_select_own_org"
  ON public.lead_inbox FOR SELECT
  USING (org_id = public.current_org_id());
