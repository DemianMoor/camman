-- Migration 0184: the Registered lane (Conversion Events Phase 4).
--
-- ONE DDL CHANGE, AND IT IS PURELY PERMISSIVE: campaign_stages.behavioral_tier
-- may now also hold 3. Nothing is dropped, no column changes type, no row is
-- rewritten.
--
-- THE TIER SCALE gains a value BETWEEN "reached offer" and the exit:
--   0 ignored · 1 clicked · 2 reached offer · 3 REGISTERED · 4 purchased (EXIT)
--
-- A registration is a $0 conversion_events row whose event type carries
-- is_retarget_signal (migration 0181). Someone who registered but has NOT
-- purchased is now its own targetable lane, ranked above "reached offer".
--
-- ⚠️ THE EXIT MOVED FROM 3 TO 4 AND THERE IS NOTHING TO BACK FILL, because the
-- contact's tier is COMPUTED (lib/campaign-tier.ts) and never stored. Measured
-- on production 2026-09-18:
--     campaign_stages      2,100 rows · behavioral_tier = 3 → 0
--     report_stage_hour       514 rows · behavioral_tier = 3 → 0
--     report_group_hour     3,431 rows · behavioral_tier = 3 → 0
-- Every stored tier is 0, 1, 2 or NULL and stays exactly what it was. The CHECK
-- below has made a stored 3 impossible since migration 0071.
--
-- ⚠️ 4 IS DELIBERATELY NOT ADMITTED. The purchased tier is an EXIT from the
-- sequence, not a lane — a contact who bought is not messaged again — so it must
-- stay unrepresentable in this column, exactly as 3 was before this migration.
--
-- A CHECK constraint cannot be altered in place, so it is dropped and re-added
-- under the same name. The re-add validates against 2,100 rows that already
-- satisfy the wider set, inside the migration's single transaction.

ALTER TABLE public.campaign_stages
  DROP CONSTRAINT IF EXISTS campaign_stages_behavioral_lane_check;
--> statement-breakpoint

ALTER TABLE public.campaign_stages
  ADD CONSTRAINT campaign_stages_behavioral_lane_check
  CHECK (
    (behavioral_tier IS NULL AND parent_stage_id IS NULL)
    OR (behavioral_tier IN (0, 1, 2, 3) AND parent_stage_id IS NOT NULL)
  );
