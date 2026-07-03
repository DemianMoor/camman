-- Migration 0090: stage_sends 'skipped_duplicate' status + recent-send dedup index.
--
-- 'skipped_duplicate' is a NEW TERMINAL status stamped by the drain when a send
-- would deliver a SECOND message to a phone that already received one within the
-- global 1-hour window (lib/sends/dedup-window.ts + lib/sends/drain.ts). The row
-- is NOT sent, NOT opted-out, NOT auto-retried — a distinct, operator-visible
-- bucket, separate from 'filtered' (provider-side suppression). The CHECK is a
-- strict superset of the prior values, so validating existing rows is instant.
ALTER TABLE public.stage_sends DROP CONSTRAINT IF EXISTS stage_sends_status_check;
ALTER TABLE public.stage_sends ADD CONSTRAINT stage_sends_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'rejected', 'filtered', 'skipped_duplicate'));

-- Dedup lookup ("has this phone been SENT within the last hour, org-wide?") runs
-- once per drain batch against the batch's claimed phones. This partial index over
-- the sent rows, keyed (org_id, phone, sent_at), serves it as a narrow probe/range
-- scan instead of a scan of the org's full send history.
CREATE INDEX IF NOT EXISTS stage_sends_org_phone_sent_at_idx
  ON public.stage_sends (org_id, phone, sent_at)
  WHERE status = 'sent';
