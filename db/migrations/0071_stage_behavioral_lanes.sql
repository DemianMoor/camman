-- Migration 0071: behavioral-branching lanes on campaign_stages.
--
-- Adds the two columns that turn an ordinary stage into a behavioral "lane":
--
--   * behavioral_tier — the high-water tier this lane targets:
--       0 = ignored, 1 = clicked, 2 = reached offer.
--     Tier 3 "converted" EXITS the sequence and is never a lane, so the
--     allowed set is {0, 1, 2}. NULL = an ordinary, non-behavioral stage
--     (today's behavior: draws from the whole frozen campaign pool).
--
--   * parent_stage_id — the stage at the PRIOR position. Used ONLY for the
--     aliveness check ("received the prior position"); it is NOT a
--     "was-in-this-lane-before" link. The recipient list is resolved live at
--     SEND time off the campaign-wide cumulative high-water tier, not off this
--     stage's ancestry. Self-FK; ON DELETE CASCADE so a lane can't outlive the
--     position it follows (which also keeps the coherence CHECK satisfiable —
--     a SET NULL would strand a lane with a tier but no parent and fail it).
--
-- Coherence (CHECK below): a stage is either fully behavioral (both fields set,
-- tier in {0,1,2}) or fully ordinary (both NULL) — never half-configured.
-- Rules a CHECK cannot express are enforced in the API: chaining is FORBIDDEN
-- (a behavioral lane may not itself be behaviorally split), the parent must
-- belong to the same campaign, and the parent must not itself be a lane.
--
-- Non-destructive: two NULLABLE columns + one self-FK + one CHECK + one partial
-- index. Every existing stage gets both columns NULL, so every non-behavioral
-- stage keeps exactly today's behavior. No backfill, no rewrite.

ALTER TABLE public.campaign_stages
  ADD COLUMN behavioral_tier integer,
  ADD COLUMN parent_stage_id integer;

ALTER TABLE public.campaign_stages
  ADD CONSTRAINT campaign_stages_parent_stage_id_campaign_stages_id_fk
  FOREIGN KEY (parent_stage_id) REFERENCES public.campaign_stages(id)
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE public.campaign_stages
  ADD CONSTRAINT campaign_stages_behavioral_lane_check
  CHECK (
    (behavioral_tier IS NULL AND parent_stage_id IS NULL)
    OR (behavioral_tier IN (0, 1, 2) AND parent_stage_id IS NOT NULL)
  );

-- Sparse: only behavioral lanes carry a parent. Backs the aliveness join
-- and "list this campaign's lanes" lookups without bloating the index with
-- the NULL rows that every ordinary stage holds.
CREATE INDEX campaign_stages_parent_stage_id_idx
  ON public.campaign_stages (parent_stage_id)
  WHERE parent_stage_id IS NOT NULL;
