-- Campaign audience: per-segment include/exclude.
-- `audience_segment_ids` keeps its meaning = the INCLUDE set (intersected with
-- groups when both present). This new column holds the EXCLUDE set — segments
-- whose members are subtracted from the positive base (groups / include-segments).
-- Additive + backward-compatible: existing rows default to '{}' (no excludes),
-- preserving current behavior.
ALTER TABLE "campaigns"
  ADD COLUMN "audience_exclude_segment_ids" integer[] NOT NULL DEFAULT '{}'::integer[];
