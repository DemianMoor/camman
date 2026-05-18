-- A/B test split partitioning for campaign_stages.
--
-- Two nullable columns let a stage target only a deterministic slice of
-- the campaign's frozen audience pool. Both NULL means "target everyone"
-- (existing behavior, preserves all current stages on deploy).
--
-- When set, the stage audience query adds:
--   mod(hashtext(contact_id::text), split_total) = split_index - 1
-- which gives roughly equal-sized buckets and is stable across previews
-- and exports — the same contact always lands in the same bucket for a
-- given (split_total) value.
--
-- The split fields are set only by
-- POST /api/campaigns/[campaignId]/stages/[stageId]/split; PATCH on the
-- stage rejects them as immutable (mirrors tracking_id behavior).

ALTER TABLE public.campaign_stages
  ADD COLUMN split_index integer,
  ADD COLUMN split_total integer;
--> statement-breakpoint

-- Either both NULL (no split) or both set with valid bounds. Cap on
-- split_total is a sanity guard against runaway inputs; 1000 is well
-- past any A/B/n test we'd realistically run.
ALTER TABLE public.campaign_stages
  ADD CONSTRAINT campaign_stages_split_pair_check
  CHECK (
    (split_index IS NULL AND split_total IS NULL)
    OR (
      split_index BETWEEN 1 AND split_total
      AND split_total BETWEEN 2 AND 1000
    )
  );
