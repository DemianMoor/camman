-- Telnyx Number Lookup — phase 1b: denormalized carrier/line-type on contacts,
-- the DB-enforced landline hard stop, eligible-partial hot-path indexes, and the
-- per-recipient carrier stamp on stage_sends.
--
-- messaging_status is a PLAIN column derived by a BEFORE INSERT/UPDATE trigger
-- (landline => 'not_applicable', everything else 'eligible'), NOT a generated
-- column. Rationale: contacts heads to millions of rows; ADD COLUMN ... GENERATED
-- forces a full-table ACCESS EXCLUSIVE rewrite that cannot be built concurrently.
-- The ADD COLUMNs use CONSTANT defaults => metadata-only (no rewrite) in PG11+.
-- No backfill: every existing row defaults to line_type='unknown' =>
-- messaging_status='eligible', already correct. The trigger fires on all future
-- writes and overrides any direct write to messaging_status, so the invariant is
-- as strong as a generated column without the rewrite.
--
-- IDEMPOTENT + LOCK-SAFE: every statement is guarded (IF NOT EXISTS / catalog
-- check) so re-running is a no-op. The four eligible-partial indexes are declared
-- here as CREATE INDEX IF NOT EXISTS for fresh/dev DBs, but in prod are built FIRST
-- (concurrently, no write lock) by scripts/apply-eligible-indexes-concurrent.ts so
-- these statements no-op. The CHECK adds validate the (already-valid) table; run
-- under a session lock_timeout with retry (see scripts/apply-lookup-migrations.ts).

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS line_type text NOT NULL DEFAULT 'unknown';
--> statement-breakpoint

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS carrier_norm text NOT NULL DEFAULT 'Unknown';
--> statement-breakpoint

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS messaging_status text NOT NULL DEFAULT 'eligible';
--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_line_type_check') THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_line_type_check
      CHECK (line_type IN ('mobile', 'landline', 'voip', 'toll_free', 'unknown'));
  END IF;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_messaging_status_check') THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_messaging_status_check
      CHECK (messaging_status IN ('eligible', 'not_applicable'));
  END IF;
END $$;
--> statement-breakpoint

-- The landline hard stop, DB-enforced. Recomputes messaging_status from line_type
-- on every insert/update; a direct write to messaging_status is overridden, so no
-- code path can create an eligible landline (or a not_applicable non-landline).
CREATE OR REPLACE FUNCTION public.contacts_derive_messaging_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.messaging_status :=
    CASE WHEN NEW.line_type = 'landline' THEN 'not_applicable' ELSE 'eligible' END;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS contacts_messaging_status_trg ON public.contacts;
--> statement-breakpoint

CREATE TRIGGER contacts_messaging_status_trg
  BEFORE INSERT OR UPDATE OF line_type, messaging_status ON public.contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.contacts_derive_messaging_status();
--> statement-breakpoint

-- Eligible-partial hot-path indexes. Predicate matches the `AND messaging_status
-- = 'eligible'` filter added to every audience/segment/send query, so landline
-- rows are physically absent from these structures. The pre-existing non-partial
-- (org_id) / (org_id, created_at) indexes are KEPT for the low-traffic Contacts
-- admin screen, the one place landlines stay visible. Built concurrently in prod
-- (see header) — these IF NOT EXISTS statements then no-op.
CREATE INDEX IF NOT EXISTS contacts_org_eligible_idx
  ON public.contacts (org_id) WHERE messaging_status = 'eligible';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS contacts_org_created_eligible_idx
  ON public.contacts (org_id, created_at) WHERE messaging_status = 'eligible';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS contacts_org_carrier_eligible_idx
  ON public.contacts (org_id, carrier_norm) WHERE messaging_status = 'eligible';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS contacts_org_linetype_eligible_idx
  ON public.contacts (org_id, line_type) WHERE messaging_status = 'eligible';
--> statement-breakpoint

-- Send-record carrier stamp (future per-carrier analytics enabler). Populated at
-- materialization/send time from the contact's carrier_norm. Nullable — historical
-- rows and rows sent before enrichment stay NULL.
ALTER TABLE public.stage_sends
  ADD COLUMN IF NOT EXISTS carrier_norm text;
