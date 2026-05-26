-- Reason tagging on opt_outs + new stage-result outcome buckets
-- (scrubbed, bounced) for phone numbers that should be excluded from
-- future audience snapshots.
--
-- Why we extend opt_outs rather than create a new table: the audience
-- snapshot query (lib/audience-snapshot.ts) already excludes any contact
-- with an opt_outs row org-wide. Tagging scrubbed/bounced rows with a
-- distinct `reason` value gives us the same exclusion semantics for free
-- while preserving the analytics distinction at the result-row level
-- (stage_result_rows.outcome) and via per-stage counters.
--
-- Scrubbed/bounced opt-outs are inserted WITHOUT a corresponding
-- opt_out_brands row — they are universal exclusions, not brand-specific
-- consent withdrawals.

-- 1. opt_outs.reason — backfill all existing rows to 'opt_out'.
ALTER TABLE public.opt_outs
  ADD COLUMN reason text NOT NULL DEFAULT 'opt_out';
--> statement-breakpoint

ALTER TABLE public.opt_outs
  ADD CONSTRAINT opt_outs_reason_check
  CHECK (reason IN ('opt_out', 'scrubbed', 'bounced'));
--> statement-breakpoint

-- 2. Per-stage counters.
ALTER TABLE public.campaign_stages
  ADD COLUMN scrubbed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN bounced_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- 3. Per-import counters.
ALTER TABLE public.stage_results_imports
  ADD COLUMN scrubbed_added integer NOT NULL DEFAULT 0,
  ADD COLUMN bounced_added integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- 4. Extend stage_result_rows.outcome CHECK to allow the two new buckets.
ALTER TABLE public.stage_result_rows
  DROP CONSTRAINT stage_result_rows_outcome_check;
--> statement-breakpoint

ALTER TABLE public.stage_result_rows
  ADD CONSTRAINT stage_result_rows_outcome_check
  CHECK (outcome IN ('delivered', 'failed', 'optout', 'clicker', 'scrubbed', 'bounced', 'noop'));
