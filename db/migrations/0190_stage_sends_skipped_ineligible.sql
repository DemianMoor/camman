-- Migration 0190: stage_sends 'skipped_ineligible' (the PR 4 send-time re-check).
--
-- A NEW TERMINAL status stamped when a claimed row fails a lifecycle check at
-- dispatch -- suppressed, freeze cadence, or bought this offer -- with the
-- reason in last_error. Distinct from skipped_opted_out (a STOP after
-- materialization), skipped_duplicate (the 1-hour dedup gate) and provider
-- rejects (failed/filtered/rejected), so stage stats can count each separately.
--
-- Nothing writes this value yet. The drain gate that produces it ships in
-- PR 4c; until then the status is reachable only by hand. That is deliberate:
-- 0187's header reserved this CHECK for PR 4, and widening it early means the
-- 12 status-enumerating UI files can grow their bucket in a PR that provably
-- changes no behaviour.
--
-- ── WHY THIS IS NOT THE DROP+ADD THE PREVIOUS THREE USED ───────────────────
-- 0065, 0090 and 0116 all widened this same constraint with a bare
-- DROP CONSTRAINT + ADD CONSTRAINT. That was correct then and is wrong now:
-- stage_sends has grown to 5,621,175 rows / 2,092 MB of heap (4,513 MB with
-- indexes), and a plain ADD CONSTRAINT revalidates every row while holding
-- ACCESS EXCLUSIVE -- which blocks the drain, the ingesters and every reader
-- for the length of the scan.
--
-- Measured on production 2026-09-25, a single-threaded sequential pass over the
-- heap evaluating exactly this predicate takes ~15 s (15,062 ms, 267,769
-- buffers). Fifteen seconds of ACCESS EXCLUSIVE on the send table is fifteen
-- seconds of stalled dispatch; fifteen seconds of SHARE UPDATE EXCLUSIVE costs
-- nothing anybody can observe.
--
-- So, per 0187's own instruction:
--   ADD ... NOT VALID   catalog-only, instant. The constraint is enforced on
--                       every INSERT and UPDATE from this moment on -- only
--                       PRE-EXISTING rows go unchecked.
--   VALIDATE CONSTRAINT one sequential pass under SHARE UPDATE EXCLUSIVE, which
--                       blocks no SELECT, INSERT, UPDATE or DELETE. It does
--                       conflict with autovacuum on this table, so if
--                       autovacuum is mid-pass the 5 s lock_timeout trips and
--                       the migration rolls back -- retry at a quieter moment
--                       rather than raising the timeout.
--
-- The new value is a strict SUPERSET of the previous eight, so no existing row
-- can fail validation and there is nothing to backfill or repair.
--
-- Between the DROP and the ADD the table is momentarily unconstrained. Both run
-- inside drizzle-kit's single migration transaction, so no other session ever
-- observes that window.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.stage_sends
  DROP CONSTRAINT IF EXISTS stage_sends_status_check;
--> statement-breakpoint
ALTER TABLE public.stage_sends
  ADD CONSTRAINT stage_sends_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'rejected',
                    'filtered', 'skipped_duplicate', 'skipped_opted_out',
                    'skipped_ineligible'))
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.stage_sends VALIDATE CONSTRAINT stage_sends_status_check;
