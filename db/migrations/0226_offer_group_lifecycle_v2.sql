-- 0226: Offer Group report lifecycle columns, Hot and Warm SEPARATE
-- (owner, 2026-10-23/26; ClickUp 1amdve284ue — phase 3 of the Hot/Warm
-- separation, phases 1–2 shipped in #402 without a migration).
--
-- offer_group_lifecycle_mv (0214, rebuilt 0215) merged hot + warm into one
-- "hw" cohort. This creates a NEW matview, offer_group_lifecycle_v2_mv, with
-- hot_* and warm_* columns in place of hw_*; cold_* and freeze_* are unchanged
-- definitions. No Hot+Warm subtotal: the screen never had one alongside
-- separate columns — Hot/Warm was the only representation.
--
-- ⚠️ ADDITIVE ONLY. The old view is NOT touched: the deployed code reads its
-- hw_* columns, and a DROP + CREATE under the same name (0215's shape) would
-- break the live report between this apply and the code deploy. The reader
-- and the twice-daily refresh switch to v2 in the code PR; the old view is
-- dropped later, in its own migration, once the new code has refreshed v2
-- cleanly in production (destructive steps follow the code).
--
-- ⚠️ WITH NO DATA. Building the view is the expensive part (~150 s at 0215,
-- above prod's 120 s server-wide statement_timeout), so this migration only
-- DEFINES it and applies in seconds through the normal db:migrate. The first
-- fill is a separate, attended step: scripts/fill-offer-group-lifecycle-v2.ts
-- runs a plain REFRESH (CONCURRENTLY cannot populate an empty matview) on the
-- report's own session-mode connection (180 s statement_timeout, raised
-- work_mem). Until filled, reading the view errors ("has not been
-- populated") — which is why the code that reads it ships only after the fill.
--
-- Everything else in 0214/0215's headers still applies: cohort = CURRENT
-- lifecycle_status (as of refresh); Sent = messages (stage_sends rows) in the
-- same scope as "Sent 30d (this offer)"; fresh pool = 0133 definition
-- (eligible, not opted out, never exposed to this offer); new / suppressed in
-- no cohort; no matview-to-matview dependency.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE MATERIALIZED VIEW IF NOT EXISTS public.offer_group_lifecycle_v2_mv AS
WITH sends AS (
  SELECT camp.org_id, camp.offer_id, ccg.contact_group_id AS group_id,
    COUNT(*) FILTER (WHERE ct.lifecycle_status = 'hot' AND ss.sent_at >= now() - interval '14 days')::bigint    AS hot_sent_14d,
    COUNT(*) FILTER (WHERE ct.lifecycle_status = 'hot')::bigint                                                   AS hot_sent_30d,
    COUNT(*) FILTER (WHERE ct.lifecycle_status = 'warm' AND ss.sent_at >= now() - interval '14 days')::bigint   AS warm_sent_14d,
    COUNT(*) FILTER (WHERE ct.lifecycle_status = 'warm')::bigint                                                  AS warm_sent_30d,
    COUNT(*) FILTER (WHERE ct.lifecycle_status = 'cold' AND ss.sent_at >= now() - interval '14 days')::bigint   AS cold_sent_14d,
    COUNT(*) FILTER (WHERE ct.lifecycle_status = 'cold')::bigint                                                  AS cold_sent_30d,
    COUNT(*) FILTER (WHERE ct.lifecycle_status = 'freeze' AND ss.sent_at >= now() - interval '14 days')::bigint AS freeze_sent_14d,
    COUNT(*) FILTER (WHERE ct.lifecycle_status = 'freeze')::bigint                                                AS freeze_sent_30d
  FROM public.stage_sends ss
  JOIN public.campaign_stages cs ON cs.id = ss.stage_id
  JOIN public.offer_report_tracked_campaigns camp ON camp.id = cs.campaign_id
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = ss.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)
   AND ccg.org_id = camp.org_id
  JOIN public.contacts ct ON ct.id = ss.contact_id AND ct.org_id = camp.org_id
  WHERE ss.status = 'sent'
    AND ss.sent_at >= now() - interval '30 days'
    AND ct.lifecycle_status IN ('hot', 'warm', 'cold', 'freeze')
  GROUP BY camp.org_id, camp.offer_id, ccg.contact_group_id
),
sendable AS (
  SELECT ccg.contact_group_id AS group_id, ct.org_id, ct.id AS contact_id,
         ct.lifecycle_status AS cohort
  FROM public.contacts ct
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = ct.id AND ccg.org_id = ct.org_id
  WHERE ct.messaging_status = 'eligible'
    AND ct.lifecycle_status IN ('hot', 'warm', 'cold', 'freeze')
    AND NOT EXISTS (
      SELECT 1 FROM public.opt_outs o
      WHERE o.contact_id = ct.id AND o.org_id = ct.org_id
    )
),
sendable_per_group AS (
  SELECT org_id, group_id,
    COUNT(*) FILTER (WHERE cohort = 'hot')::bigint    AS hot,
    COUNT(*) FILTER (WHERE cohort = 'warm')::bigint   AS warm,
    COUNT(*) FILTER (WHERE cohort = 'cold')::bigint   AS cold,
    COUNT(*) FILTER (WHERE cohort = 'freeze')::bigint AS freeze
  FROM sendable GROUP BY org_id, group_id
),
exposed_per_offer_group AS (
  SELECT s.org_id, e.offer_id, s.group_id,
    COUNT(*) FILTER (WHERE s.cohort = 'hot')::bigint    AS hot,
    COUNT(*) FILTER (WHERE s.cohort = 'warm')::bigint   AS warm,
    COUNT(*) FILTER (WHERE s.cohort = 'cold')::bigint   AS cold,
    COUNT(*) FILTER (WHERE s.cohort = 'freeze')::bigint AS freeze
  FROM sendable s
  JOIN public.offer_exposures e ON e.contact_id = s.contact_id
  GROUP BY s.org_id, e.offer_id, s.group_id
),
-- Every (offer, group) a tracked campaign of the offer targeted (0215's
-- universe, unchanged): read from the attribution universe, not from another
-- matview, so this view has no matview-to-matview dependency.
pairs AS (
  SELECT DISTINCT camp.org_id, camp.offer_id, g.group_id
  FROM public.offer_report_tracked_campaigns camp
  CROSS JOIN LATERAL unnest(camp.gids) AS g(group_id)
)
SELECT p.org_id, p.offer_id, p.group_id,
  COALESCE(s.hot_sent_14d, 0)::bigint    AS hot_sent_14d,
  COALESCE(s.hot_sent_30d, 0)::bigint    AS hot_sent_30d,
  (COALESCE(g.hot, 0) - COALESCE(x.hot, 0))::bigint       AS hot_fresh_pool,
  COALESCE(s.warm_sent_14d, 0)::bigint   AS warm_sent_14d,
  COALESCE(s.warm_sent_30d, 0)::bigint   AS warm_sent_30d,
  (COALESCE(g.warm, 0) - COALESCE(x.warm, 0))::bigint     AS warm_fresh_pool,
  COALESCE(s.cold_sent_14d, 0)::bigint   AS cold_sent_14d,
  COALESCE(s.cold_sent_30d, 0)::bigint   AS cold_sent_30d,
  (COALESCE(g.cold, 0) - COALESCE(x.cold, 0))::bigint     AS cold_fresh_pool,
  COALESCE(s.freeze_sent_14d, 0)::bigint AS freeze_sent_14d,
  COALESCE(s.freeze_sent_30d, 0)::bigint AS freeze_sent_30d,
  (COALESCE(g.freeze, 0) - COALESCE(x.freeze, 0))::bigint AS freeze_fresh_pool
FROM pairs p
LEFT JOIN sends s
  ON s.org_id = p.org_id AND s.offer_id = p.offer_id AND s.group_id = p.group_id
LEFT JOIN sendable_per_group g
  ON g.org_id = p.org_id AND g.group_id = p.group_id
LEFT JOIN exposed_per_offer_group x
  ON x.org_id = p.org_id AND x.offer_id = p.offer_id AND x.group_id = p.group_id
WITH NO DATA;
--> statement-breakpoint
-- REFRESH ... CONCURRENTLY (the twice-daily cron) requires a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS offer_group_lifecycle_v2_mv_key_uniq
  ON public.offer_group_lifecycle_v2_mv (org_id, offer_id, group_id);
--> statement-breakpoint
-- Read only over DATABASE_URL (lib/reporting/offer-group-report.ts), never
-- through PostgREST -- same REVOKE as the other report matviews (0180, 0214).
REVOKE ALL ON public.offer_group_lifecycle_v2_mv FROM anon, authenticated;
--> statement-breakpoint
-- Seeded NULL per the 0093/0132 convention: NULL = "not yet refreshed". The
-- refresh loop only UPDATEs this row, so it must exist.
INSERT INTO public.report_refresh_log (view_name, refreshed_at)
VALUES ('offer_group_lifecycle_v2_mv', NULL)
ON CONFLICT (view_name) DO NOTHING;
