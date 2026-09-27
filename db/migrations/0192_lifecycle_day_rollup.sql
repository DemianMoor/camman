-- 0192 — the Lifecycle report's nightly rollup: one row per (org, ET day, cohort).
--
-- WHY IT EXISTS. The Lifecycle report computes cohort CTR per recipient over
-- links + clicks, with nothing materialised behind it. Measured on production:
-- 2d ~13-19s, 5d ~18s, 7d ~21-26s, 14d ~34s — linear with a large constant, so
-- the route had to be capped at 14 days, well short of Overview's 92. This table
-- is what lets the cap go back up: a day is computed once and summed thereafter.
--
-- GRAIN. (org_id, et_day, cohort). `cohort` carries the six lifecycle statuses
-- plus '__unclassified__' for sends with no stage_send_lifecycle row — a real
-- value, not a NULL, so the rollup can be summed without a coalesce at every
-- read and so "history is missing" stays visible rather than becoming zero.
--
-- COUNTS, NEVER RATIOS. CTR, CR and opt-out rate are derived at read time from
-- summed numerators and denominators. Storing a per-day ratio and averaging it
-- across a window would weight a 200-send day equally with a 90,000-send one.
--
-- revenue/cost are NUMERIC(14,4): a 92-day window sums ~5M sends' worth of
-- cost, so the extra headroom over the (12,4) used per-stage is deliberate.
--
-- `reconstructed` is true when ANY send in the cell was rebuilt by the 60-day
-- backfill rather than stamped live, so the page can still mark the period.
CREATE TABLE IF NOT EXISTS lifecycle_day_rollup (
  org_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  et_day        DATE        NOT NULL,
  cohort        TEXT        NOT NULL,
  sends         INTEGER     NOT NULL DEFAULT 0,
  clickers      INTEGER     NOT NULL DEFAULT 0,
  sales         INTEGER     NOT NULL DEFAULT 0,
  revenue       NUMERIC(14, 4) NOT NULL DEFAULT 0,
  opt_outs      INTEGER     NOT NULL DEFAULT 0,
  cost          NUMERIC(14, 4) NOT NULL DEFAULT 0,
  reconstructed BOOLEAN     NOT NULL DEFAULT false,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lifecycle_day_rollup_pkey PRIMARY KEY (org_id, et_day, cohort),
  CONSTRAINT lifecycle_day_rollup_cohort_check CHECK (
    cohort IN ('new', 'cold', 'hot', 'warm', 'freeze', 'suppressed', '__unclassified__')
  )
);

-- The read is always "this org, this ET day range", and the PK's leading
-- (org_id, et_day) already serves it. This index exists for the WRITER's
-- staleness sweep, which asks "which days have not been recomputed since X"
-- across the whole table.
CREATE INDEX IF NOT EXISTS lifecycle_day_rollup_computed_at_idx
  ON lifecycle_day_rollup (computed_at);

-- RLS: own-org SELECT only, matching every other reporting table. The writer is
-- the cron, which runs as the service role and bypasses RLS.
ALTER TABLE lifecycle_day_rollup ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lifecycle_day_rollup_select_own_org ON lifecycle_day_rollup;
CREATE POLICY lifecycle_day_rollup_select_own_org ON lifecycle_day_rollup
  FOR SELECT
  USING (
    org_id IN (
      SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid()
    )
  );
