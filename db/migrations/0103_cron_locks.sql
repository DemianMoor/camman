-- W1 Task 4: single-runner overlap guard for the scheduled pollers
-- (keitaro/poll, keitaro/poll-conversions, keitaro/poll-offer-reaches,
-- opt-outs/poll). See lib/cron/lease.ts.
--
-- A lease ROW keyed by job_name — NOT a session advisory lock, which is unsafe
-- through the transaction pooler (:6543). withCronLease() upserts this row to
-- claim the lease (only if NULL or expired), runs the job, and clears it on
-- exit. skipped_count/last_skipped_at record overlap backpressure for later
-- inspection (no alert — an overlap is expected, not an incident).
--
-- watermark: W1 Task 1c high-water mark for the propagate-clickers job
-- (job_name='propagate-clickers', which uses this column, not the lease). It
-- stores the greatest clicks.scored_at already folded into `clickers`, so each
-- run processes only scored_at in (watermark, now()-5min] instead of re-deriving
-- all-time human clicks. See lib/links/propagate-clickers.ts.
--
-- Tiny operational table; idempotent create.

CREATE TABLE IF NOT EXISTS public.cron_locks (
  job_name        text PRIMARY KEY,
  lease_until     timestamptz,
  skipped_count   integer NOT NULL DEFAULT 0,
  last_skipped_at timestamptz,
  watermark       timestamptz
);
--> statement-breakpoint

COMMENT ON COLUMN public.cron_locks.watermark IS
  'Per-job high-water mark. For job_name=''propagate-clickers'': the greatest clicks.scored_at already materialized into clickers; the job processes only scored_at in (watermark, now()-5min] and advances it after a successful commit (W1 Task 1c).';
