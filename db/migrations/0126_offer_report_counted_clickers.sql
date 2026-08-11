-- Migration 0126: point the offer-group report at the unified EPC denominator,
-- and tune autovacuum for the counted-clicker cache's churn profile.
--
-- PART 1 — offer_report_campaign_econ.clicks
--
-- 0093 defined `clicks` (the report's EPC denominator) as Keitaro's clean OFFER
-- REDIRECTS, with a legacy fallback to `clean_clicks`. Every other surface now
-- divides by counted clickers (lib/reporting/counted-clickers.ts): a contact
-- with at least one click scored 'human', or a conversion (Rule F), deduplicated
-- at the grain displayed. Redirects are one funnel step later and structurally
-- ~8x smaller, so leaving this view on them would make /offers/[id]/report the
-- last screen disagreeing with the rest of the platform — the exact defect this
-- workstream exists to remove.
--
-- Dedup grain: the report aggregates to (offer, contact group), so clicks are
-- counted DISTINCT per contact within a campaign and summed across campaigns —
-- matching how `sends`, `revenue` and `sales` already aggregate here. As
-- everywhere else, counted-clicker figures are NOT additive across grains; the
-- org benchmark row recomputes rather than summing the group rows.
--
-- Manual-mode campaigns mint no links and so have no counted_clickers rows;
-- they fall back to Keitaro's clean landing VISITS, the same fallback
-- denominatorFor() applies in the application layer.
--
-- CREATE OR REPLACE VIEW cannot change a view's output column list, and the
-- dependent matviews below are defined on this view, so the view is dropped and
-- recreated with its dependents. The matview bodies are unchanged from 0093 —
-- they are reproduced verbatim so the drop/recreate is faithful.
DROP MATERIALIZED VIEW IF EXISTS public.offer_group_report_mv;
--> statement-breakpoint
DROP MATERIALIZED VIEW IF EXISTS public.offer_report_org_summary_mv;
--> statement-breakpoint
DROP VIEW IF EXISTS public.offer_report_campaign_econ;
--> statement-breakpoint
CREATE VIEW public.offer_report_campaign_econ AS
WITH stage_sales AS (
  SELECT cs.id AS stage_id, cs.campaign_id,
    GREATEST(COALESCE(k.k_sales, 0), COALESCE(m.m_sales, 0)) AS sales,
    COALESCE(k.revenue, 0)::numeric(12,4) AS revenue,
    -- Counted clickers for this stage; manual-mode stages have none and fall
    -- back to Keitaro clean landing visits.
    COALESCE(cc.counted, COALESCE(k.visits, 0)) AS clicks
  FROM public.campaign_stages cs
  LEFT JOIN (
    SELECT stage_id,
      SUM(sales)::int AS k_sales,
      SUM(revenue) AS revenue,
      SUM(visit_clicks_clean)::int AS visits
    FROM public.keitaro_stage_results
    GROUP BY stage_id
  ) k ON k.stage_id = cs.id
  LEFT JOIN (
    SELECT stage_id, COUNT(*)::int AS counted
    FROM public.counted_clickers
    GROUP BY stage_id
  ) cc ON cc.stage_id = cs.id
  LEFT JOIN (
    SELECT stage_id, SUM(delta)::int AS m_sales
    FROM public.stage_manual_sales
    GROUP BY stage_id
  ) m ON m.stage_id = cs.id
  WHERE cs.sent_at IS NOT NULL
)
SELECT
  c.id            AS campaign_id,
  c.org_id        AS org_id,
  c.offer_id      AS offer_id,
  c.audience_contact_group_ids AS group_ids,
  CASE WHEN c.link_mode = 'tracked'
       THEN COALESCE(ts.sends, 0)
       ELSE COALESCE(mc.sms_sends, 0) END AS sends,
  COALESCE(ss.revenue, 0)::numeric(12,4) AS revenue,
  COALESCE(ss.sales, 0)                  AS sales,
  COALESCE(ss.clicks, 0)                 AS clicks,
  COALESCE(cst.cost, 0)::numeric(12,4)   AS cost,
  COALESCE(oo.optouts, 0)                AS optouts
FROM public.campaigns c
JOIN (
  SELECT DISTINCT campaign_id
  FROM public.campaign_stages
  WHERE sent_at IS NOT NULL
) sent ON sent.campaign_id = c.id
LEFT JOIN (
  SELECT cs.campaign_id, COUNT(*)::bigint AS sends
  FROM public.stage_sends ss2
  JOIN public.campaign_stages cs ON cs.id = ss2.stage_id
  WHERE ss2.status = 'sent'
  GROUP BY cs.campaign_id
) ts ON ts.campaign_id = c.id
LEFT JOIN (
  SELECT campaign_id, SUM(sms_count)::bigint AS sms_sends
  FROM public.campaign_stages
  WHERE sent_at IS NOT NULL AND archived_at IS NULL
  GROUP BY campaign_id
) mc ON mc.campaign_id = c.id
LEFT JOIN (
  SELECT campaign_id, SUM(sales)::int AS sales,
         SUM(revenue) AS revenue, SUM(clicks)::int AS clicks
  FROM stage_sales GROUP BY campaign_id
) ss ON ss.campaign_id = c.id
LEFT JOIN (
  SELECT campaign_id, SUM(total_cost) AS cost
  FROM public.campaign_stages
  WHERE sent_at IS NOT NULL AND archived_at IS NULL
  GROUP BY campaign_id
) cst ON cst.campaign_id = c.id
LEFT JOIN (
  SELECT cs.campaign_id, COUNT(DISTINCT oa.opt_out_id)::int AS optouts
  FROM public.opt_out_attributions oa
  JOIN public.campaign_stages cs ON cs.id = oa.stage_id
  GROUP BY cs.campaign_id
) oo ON oo.campaign_id = c.id;
--> statement-breakpoint
CREATE MATERIALIZED VIEW public.offer_report_org_summary_mv AS
SELECT
  org_id,
  SUM(sends)::bigint            AS sends,
  SUM(revenue)::numeric(14,4)   AS revenue,
  SUM(sales)::bigint            AS sales,
  SUM(clicks)::bigint           AS clicks,
  SUM(cost)::numeric(14,4)      AS cost,
  SUM(optouts)::bigint          AS optouts
FROM public.offer_report_campaign_econ
GROUP BY org_id;
--> statement-breakpoint
CREATE UNIQUE INDEX offer_report_org_summary_mv_org_uniq
  ON public.offer_report_org_summary_mv (org_id);
--> statement-breakpoint
CREATE MATERIALIZED VIEW public.offer_group_report_mv AS
WITH e AS (
  SELECT e.org_id, e.offer_id, g.group_id,
    SUM(e.sends)::bigint          AS sends,
    SUM(e.revenue)::numeric(14,4) AS revenue,
    SUM(e.sales)::bigint          AS sales,
    SUM(e.clicks)::bigint         AS clicks,
    SUM(e.cost)::numeric(14,4)    AS cost,
    SUM(e.optouts)::bigint        AS optouts
  FROM public.offer_report_campaign_econ e
  CROSS JOIN LATERAL unnest(COALESCE(e.group_ids, ARRAY[]::int[])) AS g(group_id)
  WHERE e.offer_id IS NOT NULL
  GROUP BY e.org_id, e.offer_id, g.group_id
),
lp AS (
  SELECT ss.org_id, cs.campaign_id, ccg.contact_group_id AS group_id,
    COUNT(*) FILTER (WHERE ss.sent_at >= now() - interval '7 days')::bigint  AS sent_7d,
    COUNT(*) FILTER (WHERE ss.sent_at >= now() - interval '30 days')::bigint AS sent_30d,
    COUNT(*) FILTER (WHERE ss.sent_at >= now() - interval '90 days')::bigint AS sent_90d
  FROM public.stage_sends ss
  JOIN public.campaign_stages cs ON cs.id = ss.stage_id
  JOIN public.contact_contact_groups ccg ON ccg.contact_id = ss.contact_id
  WHERE ss.status = 'sent'
  GROUP BY ss.org_id, cs.campaign_id, ccg.contact_group_id
),
lp2 AS (
  SELECT c.org_id, c.offer_id, lp.group_id,
    SUM(lp.sent_7d)::bigint AS sent_7d,
    SUM(lp.sent_30d)::bigint AS sent_30d,
    SUM(lp.sent_90d)::bigint AS sent_90d
  FROM lp JOIN public.campaigns c ON c.id = lp.campaign_id
  WHERE c.offer_id IS NOT NULL
  GROUP BY c.org_id, c.offer_id, lp.group_id
),
fresh AS (
  SELECT ccg.contact_group_id AS group_id, ct.org_id, COUNT(*)::bigint AS fresh_pool
  FROM public.contacts ct
  JOIN public.contact_contact_groups ccg ON ccg.contact_id = ct.id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.stage_sends s2
    WHERE s2.contact_id = ct.id AND s2.status = 'sent'
      AND s2.sent_at >= now() - interval '90 days'
  )
  GROUP BY ccg.contact_group_id, ct.org_id
)
SELECT e.org_id, e.offer_id, e.group_id, cg.name AS group_name,
  e.sends, e.revenue, e.sales, e.clicks, e.cost, e.optouts,
  COALESCE(lp.sent_7d, 0)  AS sent_7d,
  COALESCE(lp.sent_30d, 0) AS sent_30d,
  COALESCE(lp.sent_90d, 0) AS sent_90d,
  COALESCE(f.fresh_pool, 0) AS fresh_pool
FROM e
LEFT JOIN public.contact_groups cg ON cg.id = e.group_id
LEFT JOIN lp2 lp ON lp.org_id = e.org_id AND lp.offer_id = e.offer_id AND lp.group_id = e.group_id
LEFT JOIN fresh f ON f.org_id = e.org_id AND f.group_id = e.group_id;
--> statement-breakpoint
CREATE UNIQUE INDEX offer_group_report_mv_key_uniq
  ON public.offer_group_report_mv (org_id, offer_id, group_id);
--> statement-breakpoint
-- PART 2 — autovacuum for counted_clickers.
--
-- MEASURED, not assumed (scripts/probe-counted-clickers-bloat.ts). The
-- incremental pass turned out to produce ZERO dead tuples: Postgres pre-checks
-- the arbiter index on INSERT ... ON CONFLICT DO NOTHING, so a conflicting row
-- never becomes a speculative tuple. 5 passes over a 6h window added 0 dead
-- tuples and only the genuinely new rows.
--
-- The churn is therefore entirely the DAILY full pass: DELETE + reinsert of the
-- whole table (~80K rows today). At the defaults (scale_factor 0.2) autovacuum
-- triggers at ~16K dead tuples, so it does fire after each rebuild — but the
-- table then carries a full day's dead tuples between runs, and the trigger
-- point rises as the table grows. A lower scale factor keeps the heap tight so
-- the rebuild does not degrade over months.
ALTER TABLE public.counted_clickers SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);
