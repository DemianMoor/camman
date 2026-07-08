CREATE TABLE public.report_refresh_log (
  view_name    text PRIMARY KEY,
  refreshed_at timestamptz
);
--> statement-breakpoint
INSERT INTO public.report_refresh_log (view_name, refreshed_at)
VALUES ('offer_group_report_mv', NULL), ('offer_report_org_summary_mv', NULL);
--> statement-breakpoint

-- Per-campaign economics for every SENT campaign of any offer (tracked + manual).
-- Shared source for both matviews. Semantics per spec §3:
--   sends   : tracked -> count(stage_sends sent); manual -> sum(campaign_stages.sms_count sent)
--   revenue : sum(keitaro revenue)               (100% Keitaro)
--   sales   : per stage max(keitaro sales, manual delta), summed across stages
--   clicks  : per keitaro row, redirect_clicks_clean when any split col > 0 else clean_clicks
--   cost    : sum(campaign_stages.total_cost) for sent stages
--   optouts : count(distinct opt_out_id) from opt_out_attributions
CREATE VIEW public.offer_report_campaign_econ AS
WITH stage_sales AS (
  SELECT cs.id AS stage_id, cs.campaign_id,
    GREATEST(COALESCE(k.k_sales, 0), COALESCE(m.m_sales, 0)) AS sales,
    COALESCE(k.revenue, 0)::numeric(12,4) AS revenue,
    COALESCE(k.clicks, 0) AS clicks
  FROM public.campaign_stages cs
  LEFT JOIN (
    SELECT stage_id,
      SUM(sales)::int AS k_sales,
      SUM(revenue) AS revenue,
      SUM(CASE
            WHEN (visit_clicks_raw > 0 OR visit_clicks_clean > 0
               OR redirect_clicks_raw > 0 OR redirect_clicks_clean > 0)
            THEN redirect_clicks_clean ELSE clean_clicks END)::int AS clicks
    FROM public.keitaro_stage_results
    GROUP BY stage_id
  ) k ON k.stage_id = cs.id
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
  SELECT campaign_id, COUNT(*)::int AS sends
  FROM public.stage_sends WHERE sent_at IS NOT NULL
  GROUP BY campaign_id
) ts ON ts.campaign_id = c.id
LEFT JOIN (
  SELECT campaign_id, SUM(sms_count)::int AS sms_sends
  FROM public.campaign_stages WHERE sent_at IS NOT NULL
  GROUP BY campaign_id
) mc ON mc.campaign_id = c.id
LEFT JOIN (
  SELECT campaign_id, SUM(sales)::int AS sales,
         SUM(revenue) AS revenue, SUM(clicks)::int AS clicks
  FROM stage_sales GROUP BY campaign_id
) ss ON ss.campaign_id = c.id
LEFT JOIN (
  SELECT campaign_id, SUM(total_cost) AS cost
  FROM public.campaign_stages WHERE sent_at IS NOT NULL
  GROUP BY campaign_id
) cst ON cst.campaign_id = c.id
LEFT JOIN (
  SELECT campaign_id, COUNT(DISTINCT opt_out_id)::int AS optouts
  FROM public.opt_out_attributions GROUP BY campaign_id
) oo ON oo.campaign_id = c.id
WHERE c.offer_id IS NOT NULL;
--> statement-breakpoint

-- Org-wide benchmark: de-duplicated (each campaign counted ONCE, no group unnest).
CREATE MATERIALIZED VIEW public.offer_report_org_summary_mv AS
SELECT org_id,
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

-- Per offer×group report. Economics from the view (campaign counted fully in each
-- targeted group); list pressure + fresh pool joined per group.
CREATE MATERIALIZED VIEW public.offer_group_report_mv AS
WITH econ AS (
  SELECT e.org_id, e.offer_id, g.group_id,
    SUM(e.sends)::bigint          AS sends,
    SUM(e.revenue)::numeric(14,4) AS revenue,
    SUM(e.sales)::bigint          AS sales,
    SUM(e.clicks)::bigint         AS clicks,
    SUM(e.cost)::numeric(14,4)    AS cost,
    SUM(e.optouts)::bigint        AS optouts
  FROM public.offer_report_campaign_econ e
  CROSS JOIN LATERAL unnest(e.group_ids) AS g(group_id)
  GROUP BY e.org_id, e.offer_id, g.group_id
),
list_pressure AS (
  -- distinct contacts in the group sent (ANY offer) within each window, as-of now()
  SELECT ss.org_id, ccg.contact_group_id AS group_id,
    COUNT(DISTINCT ss.contact_id) FILTER (WHERE ss.sent_at >= now() - interval '7 days')  AS sent_7d,
    COUNT(DISTINCT ss.contact_id) FILTER (WHERE ss.sent_at >= now() - interval '30 days') AS sent_30d,
    COUNT(DISTINCT ss.contact_id) AS sent_90d
  FROM public.stage_sends ss
  JOIN public.contact_contact_groups ccg ON ccg.contact_id = ss.contact_id
  WHERE ss.sent_at IS NOT NULL AND ss.sent_at >= now() - interval '90 days'
  GROUP BY ss.org_id, ccg.contact_group_id
),
sent_offer_contacts AS (
  SELECT DISTINCT c.offer_id, ss.contact_id
  FROM public.stage_sends ss
  JOIN public.campaigns c ON c.id = ss.campaign_id
  WHERE ss.sent_at IS NOT NULL AND c.offer_id IS NOT NULL
),
optout_contacts AS (
  SELECT DISTINCT org_id, contact_id FROM public.opt_outs WHERE contact_id IS NOT NULL
),
fresh AS (
  SELECT e.org_id, e.offer_id, e.group_id, COUNT(*) AS fresh_pool
  FROM econ e
  JOIN public.contact_contact_groups gc
    ON gc.contact_group_id = e.group_id
  LEFT JOIN sent_offer_contacts s
    ON s.offer_id = e.offer_id AND s.contact_id = gc.contact_id
  LEFT JOIN optout_contacts o
    ON o.contact_id = gc.contact_id AND o.org_id = e.org_id
  WHERE s.contact_id IS NULL AND o.contact_id IS NULL
  GROUP BY e.org_id, e.offer_id, e.group_id
)
SELECT e.org_id, e.offer_id, e.group_id, cg.name AS group_name,
  e.sends, e.revenue, e.sales, e.clicks, e.cost, e.optouts,
  COALESCE(lp.sent_7d, 0)  AS sent_7d,
  COALESCE(lp.sent_30d, 0) AS sent_30d,
  COALESCE(lp.sent_90d, 0) AS sent_90d,
  COALESCE(f.fresh_pool, 0) AS fresh_pool
FROM econ e
JOIN public.contact_groups cg ON cg.id = e.group_id AND cg.org_id = e.org_id
LEFT JOIN list_pressure lp ON lp.org_id = e.org_id AND lp.group_id = e.group_id
LEFT JOIN fresh f ON f.org_id = e.org_id AND f.offer_id = e.offer_id AND f.group_id = e.group_id;
--> statement-breakpoint
CREATE UNIQUE INDEX offer_group_report_mv_key_uniq
  ON public.offer_group_report_mv (org_id, offer_id, group_id);
--> statement-breakpoint

-- Supporting indexes for the twice-daily refresh (see spec §4.2).
CREATE INDEX IF NOT EXISTS stage_sends_sent_at_contact_idx
  ON public.stage_sends (sent_at, contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contact_contact_groups_group_contact_idx
  ON public.contact_contact_groups (contact_group_id, contact_id);
