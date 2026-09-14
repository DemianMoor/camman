-- Migration 0180: group totals for the Audience Stats report (ClickUp 869eydqn0).
--
-- /reports/audience reads offer_group_report_mv the other way round: pick a
-- contact group, get one row per offer. Its bottom row, "This group · all
-- offers", needs two columns that are NOT additive across the group's offer
-- cells:
--
--   clicks   A contact who clicked two offers is one clicker in the group.
--            Summing the cells overcounted by 25-50% on the large groups
--            (measured 2026-09-14: Memory 32,719 summed vs 23,815 distinct).
--   optouts  opt_out_attributions is unique on (opt_out_id, stage_id), so one
--            opt-out MAY be credited to several stages. None were on
--            2026-09-14 (0 of 124,717) -- but that is data, not structure.
--
-- Sends, revenue, sales, cost and sent_7d/30d/90d ARE additive: every
-- stage_sends row belongs to exactly one stage -> campaign -> offer, and the
-- cell join places it at most once per group. Those are summed from the cells;
-- only clicks and opt-outs are recomputed at group grain.
--
-- SCOPE mirrors offer_group_report_mv's cell_clicks / cell_optouts exactly
-- (offer_report_tracked_campaigns, recipient in = ANY(camp.gids), same org), so
-- per group max(cell) <= total <= sum(cells).
-- scripts/verify-audience-report.ts asserts that against this matview's
-- shipped definition.
--
-- OPT-OUT RECIPIENT comes from opt_outs.contact_id, not stage_sends.contact_id.
-- cell_optouts reaches the recipient through stage_sends: ~125K primary-key
-- lookups into a multi-million-row table, 36.8s measured. opt_outs carries the
-- same contact: 0.57s. `oa.stage_send_id IS NOT NULL` keeps cell_optouts'
-- population (it inner-joins stage_sends). Measured equal on 124,718
-- attributions (0 NULL, 0 mismatched); the verify script re-asserts it.
--
-- REFRESH ORDER: this matview reads offer_group_report_mv, so
-- refreshOfferGroupReport() refreshes it LAST. That is also the deploy-safe
-- position: code that ships before this migration throws on the final
-- statement, after the three existing matviews have already refreshed.
--
-- SECURITY: matviews carry no RLS. The app reads this one only through
-- lib/reporting/audience-report.ts over DATABASE_URL (org_id-filtered), never
-- through PostgREST, so anon/authenticated get nothing.
CREATE MATERIALIZED VIEW public.audience_report_group_totals_mv AS
WITH sums AS (
  SELECT org_id, group_id,
    SUM(sends)::bigint          AS sends,
    SUM(revenue)::numeric(14,4) AS revenue,
    SUM(sales)::bigint          AS sales,
    SUM(cost)::numeric(14,4)    AS cost,
    SUM(sent_7d)::bigint        AS sent_7d,
    SUM(sent_30d)::bigint       AS sent_30d,
    SUM(sent_90d)::bigint       AS sent_90d
  FROM public.offer_group_report_mv
  GROUP BY org_id, group_id
),
group_clicks AS (
  SELECT camp.org_id, ccg.contact_group_id AS group_id,
    COUNT(DISTINCT cc.contact_id)::bigint AS n
  FROM public.counted_clickers cc
  JOIN public.offer_report_tracked_campaigns camp ON camp.id = cc.campaign_id
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = cc.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)
   AND ccg.org_id = camp.org_id
  GROUP BY camp.org_id, ccg.contact_group_id
),
group_optouts AS (
  SELECT camp.org_id, ccg.contact_group_id AS group_id,
    COUNT(DISTINCT oa.opt_out_id)::bigint AS n
  FROM public.opt_out_attributions oa
  JOIN public.opt_outs o ON o.id = oa.opt_out_id
  JOIN public.campaign_stages cs ON cs.id = oa.stage_id
  JOIN public.offer_report_tracked_campaigns camp ON camp.id = cs.campaign_id
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = o.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)
   AND ccg.org_id = camp.org_id
  WHERE oa.stage_send_id IS NOT NULL
  GROUP BY camp.org_id, ccg.contact_group_id
)
SELECT s.org_id, s.group_id,
  s.sends, s.revenue, s.sales,
  COALESCE(k.n, 0)::bigint AS clicks,
  s.cost,
  COALESCE(x.n, 0)::bigint AS optouts,
  s.sent_7d, s.sent_30d, s.sent_90d
FROM sums s
LEFT JOIN group_clicks  k ON k.org_id = s.org_id AND k.group_id = s.group_id
LEFT JOIN group_optouts x ON x.org_id = s.org_id AND x.group_id = s.group_id;
--> statement-breakpoint
CREATE UNIQUE INDEX audience_report_group_totals_mv_key_uniq
  ON public.audience_report_group_totals_mv (org_id, group_id);
--> statement-breakpoint
REVOKE ALL ON public.audience_report_group_totals_mv FROM anon, authenticated;
--> statement-breakpoint
-- Seeded NULL, per the 0093/0132 convention: NULL means "not yet refreshed by
-- the cron", not "empty" (CREATE ... AS populated it just now). The page never
-- reads this row -- "Data as of" comes from offer_group_report_mv's row, which
-- these totals are derived from.
INSERT INTO public.report_refresh_log (view_name, refreshed_at)
VALUES ('audience_report_group_totals_mv', NULL)
ON CONFLICT (view_name) DO NOTHING;
