-- Migration 0188: contacts.lifecycle_status — a denormalised projection.
-- Spec: docs/superpowers/specs/2026-09-22-contact-lifecycle-status-design.md §6;
-- plan: docs/superpowers/plans/2026-09-23-contact-lifecycle-pr2b.md.
--
-- WHY. The contacts list filters by lifecycle status and sorts newest-first.
-- status lives in contact_engagement and created_at lives in contacts, so no
-- index can answer "the newest 21 contacts whose status is X" — the planner has
-- to walk contacts by created_at and test each row. Status correlates strongly
-- with age (freeze and suppressed contacts are by definition the old,
-- heavily-messaged ones), so that walk skips a very long way before it finds 21
-- matches. Measured on production 2026-09-23, page query, 300 ms bar:
--     cold      18 ms      new        4 ms      hot,warm   56 ms
--     warm     572 ms      freeze  3,931 ms     suppressed 13,413 ms
-- Three predicate shapes were measured; none fixes it, because the problem is
-- the absence of an index, not the spelling of the WHERE clause. With the
-- column and the index below every one of those becomes an index range scan.
--
-- SOURCE OF TRUTH. contact_engagement.status remains authoritative. This column
-- is a PROJECTION of it, maintained by the engagement job
-- (lib/engagement/refresh.ts) in the same transaction that writes the
-- contact_engagement row and its contact_engagement_transitions row, and only
-- when the status actually changes. Nothing else writes it. The status-at-send
-- stamp (stage_send_lifecycle) keeps reading contact_engagement directly.
--
-- A contact with no contact_engagement row keeps the default 'new', which is the
-- same contract the rest of the system follows (db/schema.ts:4106-4108).
--
-- ── LOCKS AND WHY NOTHING HERE REWRITES THE TABLE ──────────────────────────
-- contacts is 906,082 rows / 119 MB heap / 408 MB with indexes, and it is read
-- by the send path.
--
--  1. ADD COLUMN with a CONSTANT default is METADATA-ONLY on PostgreSQL 11+
--     (this server is 17.6): the value is stored once in pg_attribute's
--     attmissingval and materialised lazily per row on future writes. No
--     rewrite, no per-row work. ACCESS EXCLUSIVE is held for the catalog update
--     only — milliseconds.
--  2. The CHECK is added NOT VALID, which is a catalog change and does NOT scan.
--     It is enforced for every INSERT and UPDATE from that moment on.
--  3. VALIDATE CONSTRAINT then scans the heap ONCE under SHARE UPDATE EXCLUSIVE,
--     which does NOT block SELECT, INSERT, UPDATE or DELETE — only concurrent
--     DDL. Same split migration 0187 prescribed for PR 4's stage_sends CHECK.
--  4. The index is CREATE INDEX IF NOT EXISTS here, but in production it is
--     built CONCURRENTLY beforehand by
--     scripts/apply-lifecycle-status-column.ts, so this statement no-ops and the
--     migration is still recorded in the chain. CONCURRENTLY cannot run inside
--     drizzle-kit's migration transaction. Same pattern as 0101, 0109 and 0143.
--
-- ── PRODUCTION ORDER (outside the send window: before 08:00 or after 22:00 ET)
--     1. npx tsx scripts/apply-lifecycle-status-column.ts --apply
--          adds the column (catalog-only), backfills it from contact_engagement
--          in batches, THEN builds the index CONCURRENTLY, then verifies the
--          per-status counts against contact_engagement.
--     2. npm run db:migrate
--          every statement below no-ops except the CHECK, which is added and
--          validated against rows that are already correct.
--     3. npx tsx scripts/verify-migration-integrity.ts
--   The backfill runs BEFORE the index on purpose: it updates ~783K rows, and
--   maintaining a fresh index through that would cost bloat for nothing.
--   In a fresh environment (preview) db:migrate alone does all of it — the table
--   is small there, so the plain index build is instant.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'new';
--> statement-breakpoint
-- ADD CONSTRAINT has no IF NOT EXISTS, and the production order above may have
-- created nothing yet or everything already — so guard on the catalog.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contacts_lifecycle_status_check'
      AND conrelid = 'public.contacts'::regclass
  ) THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_lifecycle_status_check
      CHECK (lifecycle_status IN ('new', 'cold', 'hot', 'warm', 'freeze', 'suppressed'))
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE public.contacts VALIDATE CONSTRAINT contacts_lifecycle_status_check;
--> statement-breakpoint
-- (org_id, lifecycle_status, created_at DESC) — org and status are equality
-- predicates, created_at is the list's sort, so a filtered page becomes an index
-- range scan that stops after 21 rows regardless of how old the cohort is.
-- Built CONCURRENTLY in production before this runs; see the header.
CREATE INDEX IF NOT EXISTS contacts_org_lifecycle_created_idx
  ON public.contacts (org_id, lifecycle_status, created_at DESC);
