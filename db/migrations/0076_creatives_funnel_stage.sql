-- Add a manual `funnel_stage` field to creatives: one of
-- 'start', 'clicked', 'checkout', 'ignored', or 'unknown' (default).
-- User-managed metadata used for filtering/organizing; not enforced
-- anywhere else in the system. Mirrors the `quality` field. No data
-- backfill needed — existing rows default to 'unknown'.

ALTER TABLE public.creatives
  ADD COLUMN "funnel_stage" text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint

ALTER TABLE public.creatives
  ADD CONSTRAINT "creatives_funnel_stage_check"
  CHECK (funnel_stage IN ('start', 'clicked', 'checkout', 'ignored', 'unknown'));
