-- 0206: drip poke chain (lead-to-send speed-up). Additive only; ships dark.
--   1. org_settings.drip_poke_enabled — the ONE switch. Off (default) = every
--      step runs exactly as before, on its cron tick only. Rollback = set false.
--   2. cron_locks.poke_requested_at / poke_dispatched_at / last_run_started_at —
--      coalescing state for lib/drip/poke.ts. A poke that arrives while a run
--      holds the lease is recorded in poke_requested_at and the holder runs
--      again; poke_dispatched_at keeps at most one wake-up request in flight per
--      job; last_run_started_at spaces runs of one job POKE_MIN_GAP apart.
-- Re-runnable: ADD COLUMN IF NOT EXISTS. No backfill, no rewrite (constant default).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS drip_poke_enabled boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE public.cron_locks
  ADD COLUMN IF NOT EXISTS poke_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS poke_dispatched_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_run_started_at timestamptz;--> statement-breakpoint
COMMENT ON COLUMN public.org_settings.drip_poke_enabled IS
  'Drip poke chain (0206): each pipeline step wakes the next on completion. Off = cron ticks only. The 1-minute crons run unchanged either way.';--> statement-breakpoint
COMMENT ON COLUMN public.cron_locks.poke_requested_at IS
  'Last time any step asked this job to run (lib/drip/poke.ts). A run that started before it runs again.';--> statement-breakpoint
COMMENT ON COLUMN public.cron_locks.poke_dispatched_at IS
  'Last time a wake-up HTTP request was sent for this job. At most one unconsumed dispatch per job.';--> statement-breakpoint
COMMENT ON COLUMN public.cron_locks.last_run_started_at IS
  'Start of the latest run of this job while pokes are on. Runs are spaced POKE_MIN_GAP_MS apart.';
