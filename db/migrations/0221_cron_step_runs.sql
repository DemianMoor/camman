-- 0220: cron_step_runs — one row per execution of a scheduled job STEP, written at
-- START and completed at FINISH. Additive only; nothing reads or writes it until the
-- duration monitor ships (plan approved 2026-10-21, step 3).
--
-- Why a start row: a step killed at its function limit never reaches its finish
-- code. Heartbeats alone (cron_locks.watermark) only notice when the NEXT success is
-- late — the nightly contact-engagement run timed out silently on 09-29..10-02 and
-- 10-15..16 because a success landed inside the 50 h tolerance each time. A row
-- with started_at and no finished_at is the killed run, visible the next morning.
--
-- System table, like cron_locks: no org_id (a step runs across orgs), RLS enabled
-- with NO policy so the PostgREST/anon path sees nothing (migration 0113 pattern);
-- the app's direct connection bypasses RLS.
CREATE TABLE IF NOT EXISTS public.cron_step_runs (
  id bigserial PRIMARY KEY,
  step text NOT NULL,                         -- e.g. 'contact-engagement-recount'
  run_key text,                               -- groups resumed invocations of one pass, e.g. '2026-10-22'
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,                    -- NULL = still running, or killed
  duration_ms integer,
  limit_ms integer NOT NULL,                  -- the budget duration_ms is judged against (70% alert)
  ok boolean,                                 -- NULL until finished
  error text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb   -- per-step numbers (rows, batches, phase timings)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cron_step_runs_step_started_idx
  ON public.cron_step_runs (step, started_at DESC);--> statement-breakpoint
ALTER TABLE public.cron_step_runs ENABLE ROW LEVEL SECURITY;
