-- 0193 — stored Group × Lifecycle table: one row per (org, row, status).
--
-- WHY IT EXISTS. The report computed everything on read and the page waited
-- 15–36s across its two requests. The cost is the availability computation over
-- contact_engagement plus the rollups' DISTINCT across ~1.1M membership rows;
-- attribution between those two varied by 5x between measurement runs on a live
-- database, which is itself the argument for not computing it on read at all.
--
-- The engagement job already runs every 15 minutes and already reads the tables
-- this needs, so it computes the whole table there and stores it. The page then
-- reads ~126 rows.
--
-- GRAIN. (org_id, row_kind, row_key, status).
--   row_kind 'group'   → row_key is contact_groups.id as text
--   row_kind 'cluster' → row_key is the cluster key from lib/reporting/group-clusters.ts
--   row_kind 'all'     → row_key is '__all__', the DISTINCT total across all groups
-- Clusters and the total are stored rather than derived on read because both are
-- DISTINCT unions — they cannot be recovered by summing the group rows, which is
-- the whole point of showing them.
--
-- ⚠️ recent_days IS STORED WITH THE ROW, not assumed. The job computes N = 3;
-- any other N is computed on demand and never written here. Without the column a
-- reader could not tell which question a stored number answers, and a later
-- change to the job's default would silently reinterpret old rows.
CREATE TABLE IF NOT EXISTS group_lifecycle_rollup (
  org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  row_kind    TEXT        NOT NULL,
  row_key     TEXT        NOT NULL,
  status      TEXT        NOT NULL,
  sendable    INTEGER     NOT NULL DEFAULT 0,
  available   INTEGER     NOT NULL DEFAULT 0,
  recent_days INTEGER     NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT group_lifecycle_rollup_pkey
    PRIMARY KEY (org_id, row_kind, row_key, status),
  CONSTRAINT group_lifecycle_rollup_kind_check
    CHECK (row_kind IN ('group', 'cluster', 'all')),
  CONSTRAINT group_lifecycle_rollup_status_check
    CHECK (status IN ('new', 'cold', 'hot', 'warm', 'freeze', 'suppressed')),
  CONSTRAINT group_lifecycle_rollup_recent_days_check
    CHECK (recent_days >= 1 AND recent_days <= 90)
);

-- The read is "everything for this org", which the PK's leading column already
-- serves. No second index: the table holds ~126 rows per org, so anything else
-- would cost more to maintain than it could ever save.

-- RLS: own-org SELECT only, matching every other reporting table. The writer is
-- the cron, which runs as the service role and bypasses RLS.
ALTER TABLE group_lifecycle_rollup ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS group_lifecycle_rollup_select_own_org ON group_lifecycle_rollup;
CREATE POLICY group_lifecycle_rollup_select_own_org ON group_lifecycle_rollup
  FOR SELECT
  USING (
    org_id IN (
      SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid()
    )
  );
