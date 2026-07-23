-- Migration 0116: stage_sends 'skipped_opted_out' status (send-time opt-out invariant).
--
-- 'skipped_opted_out' is a NEW TERMINAL status stamped when a recipient opted out
-- (STOP) AFTER the stage was materialized. The frozen stage_sends set is filtered
-- for opt-outs only at materialization; the drain now re-checks opt_outs at
-- dispatch (lib/sends/drain.ts) and the two opt-out ingesters cascade-cancel any
-- still-'pending' rows on intake (lib/sends/poll-opt-outs.ts, lib/sends/ahoi-optout.ts).
-- The row is NOT sent, NOT a delivery failure, NOT a manual recall ('rejected') —
-- a distinct, operator-visible bucket (reason 'opt_out_cancel' recorded in
-- last_error) so STOP-cancels stay countable apart from provider rejects. The
-- CHECK is a strict superset of the prior values, so validating existing rows is
-- instant.
ALTER TABLE public.stage_sends DROP CONSTRAINT IF EXISTS stage_sends_status_check;
ALTER TABLE public.stage_sends ADD CONSTRAINT stage_sends_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'rejected', 'filtered', 'skipped_duplicate', 'skipped_opted_out'));
