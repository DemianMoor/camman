-- Migration 0117: parent-complete gate + bounded slip for lane children (P4).
--
-- Lane children (campaign_stages.parent_stage_id IS NOT NULL) must not fire until
-- their parent stage has FULLY sent (sent_at set AND no pending/sending rows).
-- While the parent is incomplete the scheduler re-dates the child to
-- `parent_complete + original_offset` (quiet-hours-aware), capping the total slip
-- at 24h past the original scheduled time, after which the child is HELD (parked
-- for a human) rather than fired or burned as missed. These columns carry that
-- state; they are NULL/0 for every non-lane stage and untouched by normal sends.
-- All additive/nullable (slip_count defaults 0), so no table rewrite.
ALTER TABLE public.campaign_stages
  ADD COLUMN IF NOT EXISTS slip_original_scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS slip_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS slip_hold_at timestamptz,
  ADD COLUMN IF NOT EXISTS slip_hold_reason text;
