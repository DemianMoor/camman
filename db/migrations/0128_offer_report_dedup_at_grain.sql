-- Migration 0128: dedup the offer report's clicker count AT EACH DISPLAY GRAIN.
--
-- 0126 pointed this report at counted_clickers, which fixed WHAT is counted. It
-- did not fix HOW the count is aggregated: `clicks` was summed from per-stage
-- counts into a campaign, then campaign counts were summed into an (offer,
-- group) cell, then those cells were summed again into the org benchmark. Every
-- one of those additions double-counts anyone who appears on both sides of it.
--
-- Measured before this migration:
--
--   (offer, group) cells   189,974 summed vs 151,386 distinct   +25.5%
--                          (tracked-only both sides; 60 of 72 cells inflated)
--   org benchmark           77,811 summed vs  52,142 correct    +49.2%
--
-- The overcount is structural, not incidental. 65 of 83 cells aggregate more
-- than one campaign (the largest draws on 47), so anyone who clicked two
-- campaigns of the same offer was counted twice; `unnest(group_ids)` replicates
-- a campaign's whole metrics into every group it targeted (57 of 225 campaigns
-- target more than one); and 132,952 contacts belong to multiple groups.
--
-- WHY THIS MATTERS MORE THAN THE RAW ERROR: the benchmark was inflated ~49%
-- while the group cells were inflated ~25%. Inflating a denominator depresses
-- EPC, so the benchmark's EPC was depressed HARDER than the rows' — meaning
-- every group read roughly 19% better than the org average BY CONSTRUCTION, on
-- the one screen whose entire purpose is that comparison. Fixing only the cells
-- would have inverted the bias rather than removed it, so both move together.
--
-- THE RULE, applied uniformly: a row's clicker count is a COUNT(DISTINCT
-- contact_id) over counted_clickers at that row's own grain — campaign rows at
-- campaign grain, (offer, group) cells at (offer, group), the offer footer at
-- offer grain, the org benchmark at org grain. Counts are never assembled by
-- adding up their parts. sends / revenue / sales / cost / optouts are genuinely
-- additive and keep summing.
--
-- MANUAL-MODE FALLBACK, one rule everywhere: manual-mode stages mint no links,
-- so they have no counted_clickers rows and fall back to Keitaro's clean landing
-- VISITS — an aggregate with no set behind it, so nothing can be deduplicated
-- across it. Each grain is therefore:
--
--     clicks = COUNT(DISTINCT tracked contacts at this grain)
--            + SUM(visits of the manual stages at this grain)
--
-- which is the aggregate form of the per-stage rule denominatorFor() already
-- applies, and the same shape verified on the /reports By-X tabs. It mixes a
-- deduplicated count with an undeduplicated one, so every row carrying manual
-- stages is flagged (`has_manual_stages`) and labelled in the UI rather than
-- left to look like a clean headcount. 33 of 80 cells carry the flag today.
-- Fully-manual campaigns are 1.03% of revenue and mixed ones 4.45%; splitting
-- the column into two rules for that would trade one inconsistency for another.
--
-- `offer_clicks` is carried on every row of an offer (identical per offer) so
-- the table footer can show an offer-grain distinct count without a third
-- matview or a live query. The consequence is deliberate and must stay visible
-- in the UI: the clicks column NO LONGER FOOTS. A person in two of an offer's
-- groups is one offer clicker and two group clickers, so the footer is smaller
-- than the sum of the column. That is what non-additivity looks like on screen.
--
-- CREATE OR REPLACE VIEW cannot change a view's output column list and the
-- matviews depend on the view, so all three are dropped and recreated. Parts
-- unrelated to clicks (sends/cost/optouts joins, list pressure, fresh pool) are
-- reproduced verbatim from 0126.
DROP MATERIALIZED VIEW IF EXISTS public.offer_group_report_mv;
--> statement-breakpoint
DROP MATERIALIZED VIEW IF EXISTS public.offer_report_org_summary_mv;
--> statement-breakpoint
DROP VIEW IF EXISTS public.offer_report_campaign_econ;
--> statement-breakpoint
CREATE VIEW public.offer_report_campaign_econ AS
WITH stage_sales AS (
  -- Sales and revenue only. `clicks` is NO LONGER computed per stage and summed
  -- — that summation was the defect. It is taken DISTINCT per campaign below.
  SELECT cs.id AS stage_id, cs.campaign_id,
    GREATEST(COALESCE(k.k_sales, 0), COALESCE(m.m_sales, 0)) AS sales,
    COALESCE(k.revenue, 0)::numeric(12,4) AS revenue
  FROM public.campaign_stages cs
  LEFT JOIN (
    SELECT stage_id,
      SUM(sales)::int AS k_sales,
      SUM(revenue) AS revenue
    FROM public.keitaro_stage_results
    GROUP BY stage_id
  ) k ON k.stage_id = cs.id
  LEFT JOIN (
    SELECT stage_id, SUM(delta)::int AS m_sales
    FROM public.stage_manual_sales
    GROUP BY stage_id
  ) m ON m.stage_id = cs.id
  WHERE cs.sent_at IS NOT NULL
),
-- Tracked clickers, DISTINCT within the campaign. A contact who clicked three
-- of a campaign's stages is one campaign clicker.
campaign_tracked AS (
  SELECT campaign_id, COUNT(DISTINCT contact_id)::int AS tracked
  FROM public.counted_clickers
  GROUP BY campaign_id
),
-- Manual-mode stages: no counted_clickers rows, so fall back to clean landing
-- visits. Counted here so the row can be flagged as mixing the two units.
campaign_manual AS (
  SELECT cs.campaign_id,
    SUM(COALESCE(k.visits, 0))::int AS visits,
    COUNT(*)::int AS manual_stages
  FROM public.campaign_stages cs
  LEFT JOIN (
    SELECT stage_id, SUM(visit_clicks_clean)::int AS visits
    FROM public.keitaro_stage_results
    GROUP BY stage_id
  ) k ON k.stage_id = cs.id
  WHERE cs.sent_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.counted_clickers x WHERE x.stage_id = cs.id
    )
  GROUP BY cs.campaign_id
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
  (COALESCE(ct.tracked, 0) + COALESCE(cm.visits, 0)) AS clicks,
  COALESCE(cm.manual_stages, 0) > 0      AS has_manual_stages,
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
  SELECT campaign_id, SUM(sales)::int AS sales, SUM(revenue) AS revenue
  FROM stage_sales GROUP BY campaign_id
) ss ON ss.campaign_id = c.id
LEFT JOIN campaign_tracked ct ON ct.campaign_id = c.id
LEFT JOIN campaign_manual  cm ON cm.campaign_id = c.id
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
-- Org benchmark. `clicks` is recomputed DISTINCT at ORG grain, not summed from
-- the campaign rows — this is the half that was inflated 49.2% and that biased
-- the whole screen. The universe matches the view's: campaigns with a sent stage.
CREATE MATERIALIZED VIEW public.offer_report_org_summary_mv AS
WITH base AS (
  SELECT
    org_id,
    SUM(sends)::bigint            AS sends,
    SUM(revenue)::numeric(14,4)   AS revenue,
    SUM(sales)::bigint            AS sales,
    SUM(cost)::numeric(14,4)      AS cost,
    SUM(optouts)::bigint          AS optouts,
    bool_or(has_manual_stages)    AS has_manual_stages
  FROM public.offer_report_campaign_econ
  GROUP BY org_id
),
org_tracked AS (
  SELECT c.org_id, COUNT(DISTINCT cc.contact_id)::bigint AS n
  FROM public.counted_clickers cc
  JOIN public.campaigns c ON c.id = cc.campaign_id
  WHERE EXISTS (
    SELECT 1 FROM public.campaign_stages s
    WHERE s.campaign_id = c.id AND s.sent_at IS NOT NULL
  )
  GROUP BY c.org_id
),
org_manual AS (
  SELECT c.org_id, SUM(COALESCE(k.visits, 0))::bigint AS n
  FROM public.campaign_stages cs
  JOIN public.campaigns c ON c.id = cs.campaign_id
  LEFT JOIN (
    SELECT stage_id, SUM(visit_clicks_clean)::int AS visits
    FROM public.keitaro_stage_results
    GROUP BY stage_id
  ) k ON k.stage_id = cs.id
  WHERE cs.sent_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.counted_clickers x WHERE x.stage_id = cs.id
    )
  GROUP BY c.org_id
)
SELECT b.org_id, b.sends, b.revenue, b.sales,
  (COALESCE(t.n, 0) + COALESCE(m.n, 0))::bigint AS clicks,
  b.cost, b.optouts, b.has_manual_stages
FROM base b
LEFT JOIN org_tracked t ON t.org_id = b.org_id
LEFT JOIN org_manual  m ON m.org_id = b.org_id;
--> statement-breakpoint
CREATE UNIQUE INDEX offer_report_org_summary_mv_org_uniq
  ON public.offer_report_org_summary_mv (org_id);
--> statement-breakpoint
CREATE MATERIALIZED VIEW public.offer_group_report_mv AS
WITH e AS (
  -- Additive columns only. `clicks` is NOT summed here — see cell_clicks.
  SELECT e.org_id, e.offer_id, g.group_id,
    SUM(e.sends)::bigint          AS sends,
    SUM(e.revenue)::numeric(14,4) AS revenue,
    SUM(e.sales)::bigint          AS sales,
    SUM(e.cost)::numeric(14,4)    AS cost,
    SUM(e.optouts)::bigint        AS optouts
  FROM public.offer_report_campaign_econ e
  CROSS JOIN LATERAL unnest(COALESCE(e.group_ids, ARRAY[]::int[])) AS g(group_id)
  WHERE e.offer_id IS NOT NULL
  GROUP BY e.org_id, e.offer_id, g.group_id
),
-- DISTINCT contacts at the CELL's grain. Someone who clicked three campaigns of
-- this offer, all targeting this group, is one clicker in this cell.
cell_tracked AS (
  SELECT c.org_id, c.offer_id, g.group_id,
    COUNT(DISTINCT cc.contact_id)::bigint AS n
  FROM public.counted_clickers cc
  JOIN public.campaigns c ON c.id = cc.campaign_id
  CROSS JOIN LATERAL unnest(COALESCE(c.audience_contact_group_ids, ARRAY[]::int[])) AS g(group_id)
  WHERE c.offer_id IS NOT NULL
  GROUP BY c.org_id, c.offer_id, g.group_id
),
cell_manual AS (
  SELECT c.org_id, c.offer_id, g.group_id,
    SUM(COALESCE(k.visits, 0))::bigint AS n,
    COUNT(*)::int AS manual_stages
  FROM public.campaign_stages cs
  JOIN public.campaigns c ON c.id = cs.campaign_id
  CROSS JOIN LATERAL unnest(COALESCE(c.audience_contact_group_ids, ARRAY[]::int[])) AS g(group_id)
  LEFT JOIN (
    SELECT stage_id, SUM(visit_clicks_clean)::int AS visits
    FROM public.keitaro_stage_results
    GROUP BY stage_id
  ) k ON k.stage_id = cs.id
  WHERE cs.sent_at IS NOT NULL AND c.offer_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.counted_clickers x WHERE x.stage_id = cs.id
    )
  GROUP BY c.org_id, c.offer_id, g.group_id
),
-- OFFER grain, carried on every row of the offer so the table footer can render
-- a correct total without a third matview. Deliberately NOT the sum of the
-- cells: a contact in two of the offer's groups is one offer clicker.
offer_tracked AS (
  SELECT c.org_id, c.offer_id, COUNT(DISTINCT cc.contact_id)::bigint AS n
  FROM public.counted_clickers cc
  JOIN public.campaigns c ON c.id = cc.campaign_id
  WHERE c.offer_id IS NOT NULL
  GROUP BY c.org_id, c.offer_id
),
offer_manual AS (
  SELECT c.org_id, c.offer_id,
    SUM(COALESCE(k.visits, 0))::bigint AS n,
    COUNT(*)::int AS manual_stages
  FROM public.campaign_stages cs
  JOIN public.campaigns c ON c.id = cs.campaign_id
  LEFT JOIN (
    SELECT stage_id, SUM(visit_clicks_clean)::int AS visits
    FROM public.keitaro_stage_results
    GROUP BY stage_id
  ) k ON k.stage_id = cs.id
  WHERE cs.sent_at IS NOT NULL AND c.offer_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.counted_clickers x WHERE x.stage_id = cs.id
    )
  GROUP BY c.org_id, c.offer_id
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
  e.sends, e.revenue, e.sales,
  (COALESCE(ctk.n, 0) + COALESCE(cmn.n, 0))::bigint AS clicks,
  COALESCE(cmn.manual_stages, 0) > 0 AS has_manual_stages,
  (COALESCE(otk.n, 0) + COALESCE(omn.n, 0))::bigint AS offer_clicks,
  COALESCE(omn.manual_stages, 0) > 0 AS offer_has_manual,
  e.cost, e.optouts,
  COALESCE(lp.sent_7d, 0)  AS sent_7d,
  COALESCE(lp.sent_30d, 0) AS sent_30d,
  COALESCE(lp.sent_90d, 0) AS sent_90d,
  COALESCE(f.fresh_pool, 0) AS fresh_pool
FROM e
LEFT JOIN public.contact_groups cg ON cg.id = e.group_id
LEFT JOIN cell_tracked  ctk ON ctk.org_id = e.org_id AND ctk.offer_id = e.offer_id AND ctk.group_id = e.group_id
LEFT JOIN cell_manual   cmn ON cmn.org_id = e.org_id AND cmn.offer_id = e.offer_id AND cmn.group_id = e.group_id
LEFT JOIN offer_tracked otk ON otk.org_id = e.org_id AND otk.offer_id = e.offer_id
LEFT JOIN offer_manual  omn ON omn.org_id = e.org_id AND omn.offer_id = e.offer_id
LEFT JOIN lp2 lp ON lp.org_id = e.org_id AND lp.offer_id = e.offer_id AND lp.group_id = e.group_id
LEFT JOIN fresh f ON f.org_id = e.org_id AND f.group_id = e.group_id;
--> statement-breakpoint
CREATE UNIQUE INDEX offer_group_report_mv_key_uniq
  ON public.offer_group_report_mv (org_id, offer_id, group_id);
