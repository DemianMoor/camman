-- Migration 0089: campaign_stages.materialized_at — the completeness signal for
-- windowed / resumable send materialization.
--
-- Additive nullable column (instant, no table rewrite). NULL = not (fully)
-- materialized; non-NULL = every qualifying recipient has a stage_sends row.
-- The scheduler resumes any due stage with materialized_at IS NULL and only
-- DRAINS (sends) stages with materialized_at IS NOT NULL, so a partially-built
-- audience can never be sent. See lib/sends/kickoff.ts + lib/sends/scheduled.ts.
ALTER TABLE public.campaign_stages
  ADD COLUMN IF NOT EXISTS materialized_at TIMESTAMPTZ;

-- Backfill (load-bearing): under the OLD model materialization was atomic, so any
-- stage that already has stage_sends rows was fully materialized. Mark those
-- complete — otherwise the new scheduler would (a) refuse to drain already
-- in-flight/sent stages (Phase B gates on materialized_at IS NOT NULL) and (b)
-- try to "resume" them. Use sent_at when present, else created_at (any non-NULL
-- past instant works; the value is only ever tested for NULL-ness). Stages with
-- no stage_sends rows stay NULL (nothing materialized yet).
UPDATE public.campaign_stages s
SET materialized_at = COALESCE(s.sent_at, s.created_at)
WHERE s.materialized_at IS NULL
  AND EXISTS (SELECT 1 FROM public.stage_sends ss WHERE ss.stage_id = s.id);
