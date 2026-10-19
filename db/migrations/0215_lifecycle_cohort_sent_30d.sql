-- 0215: lifecycle cohort Sent window 90d -> 30d (owner request, 2026-10-19).
--
-- offer_group_lifecycle_mv (0214) is rebuilt with hw/cold/freeze_sent_30d in
-- place of *_sent_90d. Only the COHORT columns change: the overall
-- "Sent 90d (this offer)" on offer_group_report_mv is untouched, and Sent 14d
-- and the fresh pools keep their 0214 definitions. Everything else in 0214's
-- header still applies (current status, messages, same scope as sent_7d/30d/90d).
--
-- DROP + CREATE: nothing depends on this view (it was built to have no
-- dependents), so no other object is recreated. The report_refresh_log row
-- from 0214 is kept; it is reset to NULL below because the stamp described the
-- old definition.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DROP MATERIALIZED VIEW public.offer_group_lifecycle_mv;
--> statement-breakpoint
CREATE MATERIALIZED VIEW public.offer_group_lifecycle_mv AS
WITH sends AS (
  SELECT camp.org_id, camp.offer_id, ccg.contact_group_id AS group_id,
    COUNT(*) FILTER (WHERE ct.lifecycle_status IN ('hot', 'warm') AND ss.sent_at >= now() - interval '14 days')::bigint AS hw_sent_14d,
    COUNT(*) FILTER (WHERE ct.lifecycle_status IN ('hot', 'warm'))::bigint                                              AS hw_sent_30d,
    COUNT(*) FILTER (WHERE ct.lifecycle_status = 'cold' AND ss.sent_at >= now() - interval '14 days')::bigint            AS cold_sent_14d,
    COUNT(*) FILTER (WHERE ct.lifecycle_status = 'cold')::bigint                                                         AS cold_sent_30d,
    COUNT(*) FILTER (WHERE ct.lifecycle_status = 'freeze' AND ss.sent_at >= now() - interval '14 days')::bigint          AS freeze_sent_14d,
    COUNT(*) FILTER (WHERE ct.lifecycle_status = 'freeze')::bigint                                                       AS freeze_sent_30d
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
         CASE WHEN ct.lifecycle_status IN ('hot', 'warm') THEN 'hw' ELSE ct.lifecycle_status END AS cohort
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
    COUNT(*) FILTER (WHERE cohort = 'hw')::bigint     AS hw,
    COUNT(*) FILTER (WHERE cohort = 'cold')::bigint   AS cold,
    COUNT(*) FILTER (WHERE cohort = 'freeze')::bigint AS freeze
  FROM sendable GROUP BY org_id, group_id
),
exposed_per_offer_group AS (
  SELECT s.org_id, e.offer_id, s.group_id,
    COUNT(*) FILTER (WHERE s.cohort = 'hw')::bigint     AS hw,
    COUNT(*) FILTER (WHERE s.cohort = 'cold')::bigint   AS cold,
    COUNT(*) FILTER (WHERE s.cohort = 'freeze')::bigint AS freeze
  FROM sendable s
  JOIN public.offer_exposures e ON e.contact_id = s.contact_id
  GROUP BY s.org_id, e.offer_id, s.group_id
),
-- Every (offer, group) a tracked campaign of the offer targeted: a superset of
-- offer_group_report_mv's rows (those also need a send), read from the same
-- attribution universe instead of from that matview so this view has no
-- matview-to-matview dependency. Extra rows are harmless -- the reader joins
-- onto the group report's rows.
pairs AS (
  SELECT DISTINCT camp.org_id, camp.offer_id, g.group_id
  FROM public.offer_report_tracked_campaigns camp
  CROSS JOIN LATERAL unnest(camp.gids) AS g(group_id)
)
SELECT p.org_id, p.offer_id, p.group_id,
  COALESCE(s.hw_sent_14d, 0)::bigint     AS hw_sent_14d,
  COALESCE(s.hw_sent_30d, 0)::bigint     AS hw_sent_30d,
  (COALESCE(g.hw, 0) - COALESCE(x.hw, 0))::bigint         AS hw_fresh_pool,
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
  ON x.org_id = p.org_id AND x.offer_id = p.offer_id AND x.group_id = p.group_id;
--> statement-breakpoint
CREATE UNIQUE INDEX offer_group_lifecycle_mv_key_uniq
  ON public.offer_group_lifecycle_mv (org_id, offer_id, group_id);
--> statement-breakpoint
-- Read only over DATABASE_URL (lib/reporting/offer-group-report.ts), never
-- through PostgREST -- same REVOKE as the other report matviews (0180).
REVOKE ALL ON public.offer_group_lifecycle_mv FROM anon, authenticated;
--> statement-breakpoint
-- NULL = "not yet refreshed by the cron" (0093/0132 convention).
UPDATE public.report_refresh_log SET refreshed_at = NULL
WHERE view_name = 'offer_group_lifecycle_mv';
