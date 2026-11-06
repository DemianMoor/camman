-- 0237: contact blocks + soft delete — schema (Phase 1, PR 1).
-- Spec: docs/superpowers/specs/2026-11-06-contact-blocks-soft-delete-design.md
--
-- ADDITIVE. Leads the code (feedback: additive migrations lead the code). Adds:
--   • contact_block_batches — one row per block-list upload (history + release,
--     modelled on stage_results_imports.reverted_at).
--   • contact_blocks — the phone-keyed ledger. NO FK to contacts on purpose: a
--     row may exist for a phone the org has never imported (D3) and must outlive
--     a Phase 2 erase. One ACTIVE row per (org, phone) — the partial unique index
--     is also the index every import check probes.
--   • contacts.blocked_at / block_reason, mirrored from the ledger (invariant D2:
--     blocked_at IS NOT NULL ⇔ an active non-'deleted' ledger row).
--   • messaging_status gains 'blocked' (D1): the trigger now derives it from
--     blocked_at / archived_at, so every existing `messaging_status = 'eligible'`
--     gate (segment + group sources, snapshot, previews, the three offer-group
--     matviews, group-lifecycle, lookup stats) excludes blocked and deleted
--     contacts with no SQL change.
--   • lead_intake_daily / lead_intake_hourly.blocked — the drip intake discard
--     counter (O6).
--
-- NO ROW CHANGES VALUE. 0 contacts are archived and 0 are blocked on prod
-- (read-only check, 2026-11-06), so re-deriving messaging_status is a no-op for
-- every existing row; the trigger change only affects future writes.
--
-- ⚠️ ONE BEHAVIOUR CHANGE SHIPS WITH THIS FILE: once applied, archiving a contact
-- through the existing archive route flips it to 'blocked' and removes it from
-- every eligible-gated audience. That is the approved meaning of "deleted" (O1),
-- and archive is unused today (0 rows); the archive route gets its ledger row +
-- send-cancel in PR 2.
--
-- The two partial indexes on contacts (1.8M rows) are built CONCURRENTLY first by
-- scripts/apply-contact-blocks-indexes-concurrent.ts; the IF NOT EXISTS
-- statements below then no-op on prod and build plainly on the preview DB.
--
-- The messaging_status CHECK is re-added NOT VALID and then VALIDATEd in the same
-- transaction: the validation scans contacts (~247 MB heap) while the table is
-- locked by the ADD — about a second, under the 5 s lock_timeout's reach.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.contact_block_batches (
  id serial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  filename text,
  reason text NOT NULL CONSTRAINT contact_block_batches_reason_check
    CHECK (reason IN ('provider_list', 'manual', 'complaint', 'carrier_block')),
  source text,
  note text,
  submitted_rows integer NOT NULL,
  valid_rows integer NOT NULL,
  invalid_rows integer NOT NULL,
  blocked_added integer NOT NULL DEFAULT 0,
  already_blocked integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  released_count integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_block_batches_org_created_idx
  ON public.contact_block_batches (org_id, created_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.contact_blocks (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- E.164, normalized by validatePhone (strict) before it reaches the DB — the
  -- same key as contacts.phone_number. No FK to contacts (see header).
  phone_number text NOT NULL,
  reason text NOT NULL CONSTRAINT contact_blocks_reason_check
    CHECK (reason IN ('provider_list', 'manual', 'deleted', 'complaint', 'carrier_block')),
  source text,
  note text,
  batch_id integer REFERENCES public.contact_block_batches(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  released_at timestamptz,
  released_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
--> statement-breakpoint
-- One active row per phone; also the import check's probe.
CREATE UNIQUE INDEX IF NOT EXISTS contact_blocks_org_phone_active_uniq
  ON public.contact_blocks (org_id, phone_number) WHERE released_at IS NULL;
--> statement-breakpoint
-- Block history for a phone (contact detail page), released rows included.
CREATE INDEX IF NOT EXISTS contact_blocks_org_phone_created_idx
  ON public.contact_blocks (org_id, phone_number, created_at DESC);
--> statement-breakpoint
-- Batch release; leads with the FK column.
CREATE INDEX IF NOT EXISTS contact_blocks_batch_idx
  ON public.contact_blocks (batch_id) WHERE batch_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS blocked_at timestamptz;
--> statement-breakpoint
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS block_reason text;
--> statement-breakpoint
-- 'deleted' is never a block_reason: a deleted contact carries archived_at, not
-- blocked_at (D2). The two columns are set and cleared together.
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_block_reason_check;
--> statement-breakpoint
ALTER TABLE public.contacts ADD CONSTRAINT contacts_block_reason_check
  CHECK (block_reason IN ('provider_list', 'manual', 'complaint', 'carrier_block')
         AND (blocked_at IS NULL) = (block_reason IS NULL)) NOT VALID;
--> statement-breakpoint
ALTER TABLE public.contacts VALIDATE CONSTRAINT contacts_block_reason_check;
--> statement-breakpoint
-- Built CONCURRENTLY on prod first (see header); these no-op there.
CREATE INDEX IF NOT EXISTS contacts_org_blocked_idx
  ON public.contacts (org_id, blocked_at DESC) WHERE blocked_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contacts_org_archived_idx
  ON public.contacts (org_id, archived_at DESC) WHERE archived_at IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_messaging_status_check;
--> statement-breakpoint
ALTER TABLE public.contacts ADD CONSTRAINT contacts_messaging_status_check
  CHECK (messaging_status IN ('eligible', 'not_applicable', 'blocked')) NOT VALID;
--> statement-breakpoint
ALTER TABLE public.contacts VALIDATE CONSTRAINT contacts_messaging_status_check;
--> statement-breakpoint
-- D1. Precedence: blocked/deleted outranks landline. Opt-outs are NOT folded in
-- (they stay in opt_outs, consulted by every path as today).
CREATE OR REPLACE FUNCTION public.contacts_derive_messaging_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.messaging_status :=
    CASE
      WHEN NEW.blocked_at IS NOT NULL OR NEW.archived_at IS NOT NULL THEN 'blocked'
      WHEN NEW.line_type = 'landline' THEN 'not_applicable'
      ELSE 'eligible'
    END;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS contacts_messaging_status_trg ON public.contacts;
--> statement-breakpoint
CREATE TRIGGER contacts_messaging_status_trg
  BEFORE INSERT OR UPDATE OF line_type, messaging_status, blocked_at, archived_at ON public.contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.contacts_derive_messaging_status();
--> statement-breakpoint
ALTER TABLE public.lead_intake_daily ADD COLUMN IF NOT EXISTS blocked integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE public.lead_intake_hourly ADD COLUMN IF NOT EXISTS blocked integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE public.contact_block_batches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.contact_blocks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "contact_block_batches_select_own_org" ON public.contact_block_batches;
--> statement-breakpoint
CREATE POLICY "contact_block_batches_select_own_org" ON public.contact_block_batches
  FOR SELECT USING (org_id = public.current_org_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "contact_blocks_select_own_org" ON public.contact_blocks;
--> statement-breakpoint
CREATE POLICY "contact_blocks_select_own_org" ON public.contact_blocks
  FOR SELECT USING (org_id = public.current_org_id());
