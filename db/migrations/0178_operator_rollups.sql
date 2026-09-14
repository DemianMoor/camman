-- operator_rollups — saved results behind operator-API endpoints whose live
-- computation is too slow to run per request. One row per (org, rollup_key),
-- refreshed by a cron, read by the endpoint, the timestamp travelling with the
-- answer so it is never presented as live. Generalises audience_fresh_counts
-- (0176) so each new rollup is a key, not a migration.
--
-- Keys: 'audience_pools' (GET /api/audience/pools, cron refresh-audience-pools),
-- 'performance_creative_lifetime' (GET /api/reports/performance
-- dimension=creative range=lifetime). Spec:
-- docs/superpowers/specs/2026-09-14-operator-api-pools-creative-design.md
--
-- ⚠️ THE BLOBS HOLD ONLY AGGREGATES — group names, offer / creative ids and
-- integers. No contact ids, no phone numbers, nothing to strip at the response
-- boundary.
CREATE TABLE IF NOT EXISTS public.operator_rollups (
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  rollup_key text NOT NULL,
  data jsonb,
  -- The instant the numbers describe. NULL until the first cron run: the
  -- endpoint answers 503, never a misleading zero.
  computed_at timestamptz,
  duration_ms integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, rollup_key)
);
--> statement-breakpoint
ALTER TABLE public.operator_rollups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "operator_rollups_select_own_org"
  ON public.operator_rollups FOR SELECT
  USING (org_id = public.current_org_id());
