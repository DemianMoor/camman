-- Migration 0077: retire the "Late Clickers" metric and the late-clicker CSV
-- import mode entirely.
--
-- Stage results now auto-populate from upstream sources: Keitaro fills clickers
-- (landing-page visits), checkout clicks, and sales; TextHub fills opt-outs. The
-- separate "late clicker" follow-up bucket — a CSV-only concept — is no longer
-- needed, so its column and the import plumbing that fed it are removed with
-- their data.
--
-- Drops:
--   campaign_stages.late_click_count          — the "Late Clickers" report field
--   stage_results_imports.late_clickers_added — late-import audit counter
--   stage_results_imports.clicker_phase       — day1/late import discriminator
--
-- The clicker_phase CHECK constraint is dropped explicitly first; it would also
-- drop automatically with its column, but being explicit keeps the intent clear.
ALTER TABLE public.stage_results_imports
  DROP CONSTRAINT IF EXISTS stage_results_imports_clicker_phase_check;

ALTER TABLE public.campaign_stages
  DROP COLUMN IF EXISTS late_click_count;

ALTER TABLE public.stage_results_imports
  DROP COLUMN IF EXISTS late_clickers_added,
  DROP COLUMN IF EXISTS clicker_phase;
