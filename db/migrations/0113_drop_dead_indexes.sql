-- W1 Task 2 (ClickUp 869e462k5): drop two dead partial indexes on `contacts`.
--
-- Numbering: this is 0113 and INTENTIONALLY SKIPS 0111 and 0112, which are
-- RESERVED for the provider-credentials encryption cutover (not yet drafted).
-- The gap is deliberate — not a missing/lost migration.
--
-- Scope (from the +18h idx_scan diff — docs/idx-audit-snapshot-2026-07-14T2018Z.md):
--   DROP contacts_org_eligible_idx          (idx_scan 0 → 0 over the window: unused)
--   DROP contacts_org_created_eligible_idx  (idx_scan 0 → 0 over the window: unused)
-- KEPT (not dropped here):
--   contact_contact_groups_group_contact_idx (4 → 6: in use — "any use = keep")
--   contacts_org_carrier_eligible_idx / contacts_org_linetype_eligible_idx
--     (new carrier-v2 partials; re-audit after 2+ weeks of live carrier v2 with
--      real campaign-creation activity — folded into W2 Task 1)
--
-- Apply discipline: on PRODUCTION these were dropped OUT-OF-BAND as
-- `DROP INDEX CONCURRENTLY` (no ACCESS EXCLUSIVE lock on the hot `contacts`
-- table), then this migration was bookkept into drizzle.__drizzle_migrations —
-- the same pattern as the W1 index CREATEs (CONCURRENTLY cannot run inside
-- drizzle's migration transaction). The plain `DROP INDEX IF EXISTS` below is
-- the transaction-safe form, so a fresh-DB `db:migrate` replay (no load) nets
-- migration 0096's CREATEs against these DROPs correctly.
-- Rollback (exact CREATE defs): db/rollback-w1-indexes.sql.

DROP INDEX IF EXISTS public.contacts_org_eligible_idx;
--> statement-breakpoint

DROP INDEX IF EXISTS public.contacts_org_created_eligible_idx;
