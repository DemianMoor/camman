-- 0182 conversion reader switch (Phase 3) — ADDITIVE ONLY.
--
-- 1. keitaro_stage_results.pending_revenue: the stage-day projection gains a
--    SECOND money column, because revenue becomes approved-only and pending
--    revenue must be visible without being added into it (user decision 3).
--    Every stage-grain surface already sums this table, so one column carries
--    pending revenue to /reports and the campaign view with no new query path.
-- 2. conversion_events (updated_at): the poll re-derives the stage-days whose
--    LEDGER ROWS CHANGED this tick. occurred_at never moves (Phase 1), so
--    updated_at is the only key that finds a re-posted old conversion. Not
--    org-scoped: the Keitaro poll is cross-org by construction (it maps rows to
--    orgs by sub_id_3), exactly like the campaign_stages counter mirror it
--    already runs.
--
-- Recon: docs/superpowers/specs/2026-09-17-multi-event-conversions-recon.md
-- Plan:  docs/superpowers/plans/2026-09-17-conversion-events-phase3.md

ALTER TABLE public.keitaro_stage_results
  ADD COLUMN IF NOT EXISTS pending_revenue numeric(12, 4) NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversion_events_updated_at_idx
  ON public.conversion_events (updated_at);
