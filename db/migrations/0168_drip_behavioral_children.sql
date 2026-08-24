-- Migration 0168: behavioural follow-up children (Drip Phase 6, Q3).
--
-- ⚠️ ALMOST NOTHING IS NEEDED HERE, AND THAT IS THE POINT.
-- campaign_stages ALREADY carries parent_stage_id and behavioral_tier, and 536
-- lane children are live on regular campaigns (161 at tier 0, 188 at tier 1,
-- 187 at tier 2). lib/sends/recipients.ts already selects a lane by
-- coalesce(tier,0) = behavioral_tier with an explicit <> 3 guard, and
-- lib/sends/child-slip.ts already gates a child on its parent completing.
-- Ignored / Clicked / Offer map exactly onto tiers 0 / 1 / 2, and converted (3)
-- is an EXIT rather than a lane — already enforced.
--
-- Building a parallel drip-only children table would have duplicated all of
-- that, and the two copies would have drifted the first time either changed.
--
-- ⚠️ WHAT IS GENUINELY MISSING IS THE TIMER, and it is a different KIND of
-- schedule. A regular lane child fires at an ABSOLUTE campaign_stages
-- .scheduled_at the operator picked. A drip child fires a RELATIVE interval
-- after THIS CONTACT'S own detection moment, so one stage serves contacts whose
-- clocks all started at different times. That cannot be expressed in
-- scheduled_at, which is why a new column exists at all.
--
-- Minutes, not an interval: the UI offers a fixed option list (Ignored 1–24h,
-- Clicked 15m–24h, Offer 15m–24h) and minutes are exactly that domain. smallint
-- holds 24h (1440) with room to spare.

ALTER TABLE public.campaign_stages
  ADD COLUMN drip_followup_minutes smallint;
--> statement-breakpoint

ALTER TABLE public.campaign_stages
  ADD CONSTRAINT campaign_stages_drip_followup_minutes_check CHECK (
    drip_followup_minutes IS NULL
    OR (drip_followup_minutes >= 1 AND drip_followup_minutes <= 1440)
  );
--> statement-breakpoint

-- The activation toggle, per child, WITHOUT deleting it (spec: "toggleable
-- without delete"). Reuses drip_active, which already means exactly this for a
-- first-send stage — a configured stage that does not fire. NULL on every
-- existing row, so no regular lane child changes behaviour.

-- Campaign-level behavioural on/off. DEFAULT FALSE: an existing drip campaign
-- gains no children and no follow-ups until an operator opts in.
ALTER TABLE public.drip_campaign_configs
  ADD COLUMN behavioral_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- The scheduler's per-parent child scan: a parent's active behavioural children
-- in tier order.
CREATE INDEX campaign_stages_drip_children_idx
  ON public.campaign_stages (parent_stage_id, behavioral_tier)
  WHERE parent_stage_id IS NOT NULL AND drip_followup_minutes IS NOT NULL;
