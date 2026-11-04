-- 0231: the Offer report and Audience Stats attribute each conversion to the
-- offer it converted on (per-offer conversion attribution, Phase 3).
--
-- Phase 1 (#430) stores a conversion under the CamMan offer mapped from its
-- Keitaro offer, so conversion_events.offer_id can differ from the offer of the
-- campaign that sent it (35 rows on prod, 2026-11-04). Phase 2 (#431) split the
-- runtime by-offer reports. This file does the same for the three report
-- matviews, as NEW *_v2 matviews next to the old ones:
--
--   offer_split_amounts_v            (view)   the split part of each stage
--   offer_group_report_v2_mv         (matview) Offers x Group cells
--   audience_report_group_totals_v2_mv (matview) Audience Stats rows (sums the above)
--   offer_report_offer_totals_v2_mv  (matview) the Offer report footer
--
-- ── WHAT "SPLIT" MEANS (Ruling R3) ────────────────────────────────────────────
-- A ledger row is a SPLIT row when it carries an offer and that offer IS
-- DISTINCT FROM the offer of the campaign its STAGE belongs to (ce.stage_id ->
-- campaign_stages -> campaigns, org-scoped). That is getOfferSplits'
-- selection (lib/reporting/offer-splits.ts), lifetime, and the amounts use the
-- lib/sale-attribution.ts predicates copied literally (the same text 0183 uses):
--   sales    event_type_id IN (is_purchase)    AND status IN ('pending','approved')
--   revenue  event_type_id IN (counts_revenue) AND status = 'approved'
--   pending  event_type_id IN (counts_revenue) AND status = 'pending'
-- Every ledger row is EITHER own-offer (kept in `conv`, as before) OR split
-- (moved), never both and never neither: `conv` excludes exactly the rows the
-- split predicate selects, with the same join path.
--
-- ── HOW EACH VIEW MOVES THE MONEY ─────────────────────────────────────────────
-- * Group cells: the expensive stage_sends pass (`rate`, `attr`) is reproduced
--   from 0183 VERBATIM; only `conv` loses the split rows. A small `moved` CTE
--   takes the split rows (32 of the 35 on prod sit on a sent send), joins them
--   to stage_sends by PRIMARY KEY and to the recipient's targeted groups with
--   the SAME rule `attr` uses (ccg.contact_group_id = ANY(camp.gids),
--   org-scoped), and groups them by (org, ce.offer_id, group) with
--   sends = cost = sent_* = 0. `cells` = attr
--   UNION ALL moved, re-aggregated. So per group, summed over offers, nothing
--   changes — the money only changes offer. A target offer with no campaign of
--   its own (82, 124 today) gets rows with sends 0; `fresh` reads its offer list
--   from `cells` so those rows carry a fresh pool too. Clicks and opt-outs stay
--   with the sending campaign's offer (they are traffic, not conversions).
-- * Audience Stats: 0183's text over the v2 cells. Its numbers are UNCHANGED by
--   construction (each group's sum over offers is conserved).
-- * Offer footer, stage-grain half (`base`, Keitaro revenue / GREATEST sales
--   from offer_report_campaign_econ): offer_split_amounts_v is subtracted from
--   the campaign's offer and added to the conversion's offer — the SQL twin of
--   splitStageMetrics. A target offer with no campaigns of its own still gets a
--   row (sends 0). Only splits whose campaign HAS an offer are applied: a
--   campaign without one has no `base` row to take them from, so applying the
--   add without the subtract would mint revenue (none on prod).
-- * Offer footer, ledger half (`attributable`): 0183's CTE verbatim over the
--   own-offer `conv`, plus `attributable_moved` (split rows on a sent,
--   group-targeted send — the same EXISTS membership test) with n = 0.
--
-- NOT REPLICATED: splitStageMetrics' "would_go_negative" skip (a stage whose
-- splits exceed what its tracker totals hold is left unsplit at runtime). The
-- matview applies every split. Zero such stages on prod at 2026-11-04;
-- scripts/verify-offer-report-v2.ts counts them and fails if any appear.
--
-- ── WHY *_v2 AND WITH NO DATA (Ruling R18) ────────────────────────────────────
-- The group view's build is the ~165 s stage_sends pass, against db:migrate's
-- 120 s server-default statement_timeout, and an in-place DROP + CREATE would
-- blank Audience Stats until rebuilt. So this file only DEFINES the v2 views
-- (the 0226 / 0227 pattern) and leaves the old three untouched. The first fill
-- is attended, outside the 05:00/05:30/20:00/20:30 UTC refresh runs:
-- scripts/fill-offer-report-v2.ts (plain REFRESH on the report's session
-- connection, 230 s / 384 MB), then scripts/verify-offer-report-v2.ts. The code
-- that reads the v2 names AND refreshes them INSTEAD of the old ones (never
-- both) deploys after that. The old views are dropped by a later migration once
-- the owner has reviewed the numbers.
--
-- Refresh cost: the added CTEs read conversion_events (~3.5K rows) and reach
-- stage_sends by primary key only. EXPLAIN (ANALYZE, BUFFERS) of each new piece
-- alone, prod, read-only, 2026-11-04 (warm / first run):
--   offer_split_amounts_v body        7.3 / 15.8 ms   (read twice by the footer)
--   conv with the own-offer filter   23.6 / 34.6 ms
--   split_ce + moved (group view)     9.0 / 72.3 ms   (31 stage_sends PK lookups)
--   split_ce + attributable_moved    16.0 / 16.4 ms
-- i.e. well under a second added to refreshes of ~165 s (group) and ~36 s
-- (footer). The full view definitions were NOT run on prod for this (that is
-- the ~3-minute heavy read); the first fill's per-view timings are the check.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE OR REPLACE VIEW public.offer_split_amounts_v
WITH (security_invoker = true) AS
SELECT s.org_id, s.stage_id, s.campaign_offer_id, s.offer_id, s.sales, s.revenue, s.pending_revenue
FROM (
  SELECT ce.org_id, ce.stage_id, ca.offer_id AS campaign_offer_id, ce.offer_id,
    COUNT(*) FILTER (
      WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE is_purchase)
        AND ce.status IN ('pending', 'approved')
    )::bigint AS sales,
    COALESCE(SUM(ce.revenue) FILTER (
      WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE counts_revenue)
        AND ce.status = 'approved'
    ), 0)::numeric(14,4) AS revenue,
    COALESCE(SUM(ce.revenue) FILTER (
      WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE counts_revenue)
        AND ce.status = 'pending'
    ), 0)::numeric(14,4) AS pending_revenue
  FROM public.conversion_events ce
  JOIN public.campaign_stages cs ON cs.id = ce.stage_id AND cs.org_id = ce.org_id
  JOIN public.campaigns ca ON ca.id = cs.campaign_id AND ca.org_id = ce.org_id
  WHERE ce.offer_id IS NOT NULL
    AND ce.offer_id IS DISTINCT FROM ca.offer_id
  GROUP BY ce.org_id, ce.stage_id, ca.offer_id, ce.offer_id
) s
-- A (stage, offer) that moves none of the three amounts (only rejected or
-- unmapped rows) is omitted, as isMovingSplit omits it: it would otherwise mint
-- an all-zero row for its offer in the matviews below. getOfferSplits' per-event
-- counts have no column here, so they are not part of the test.
WHERE s.sales <> 0 OR s.revenue <> 0 OR s.pending_revenue <> 0;
--> statement-breakpoint
REVOKE ALL ON public.offer_split_amounts_v FROM anon, authenticated;
--> statement-breakpoint
CREATE MATERIALIZED VIEW IF NOT EXISTS public.offer_group_report_v2_mv AS
-- Effective per-send cost from the STAGE. stage_sends.cost_per_sms is NULL on
-- 32.7% of sent rows and would silently under-count older campaigns.
WITH rate AS (
  SELECT cs.id AS stage_id,
         cs.total_cost / NULLIF(COUNT(ss.id), 0) AS per_send
  FROM public.campaign_stages cs
  LEFT JOIN public.stage_sends ss ON ss.stage_id = cs.id AND ss.status = 'sent'
  WHERE cs.sent_at IS NOT NULL AND cs.archived_at IS NULL
  GROUP BY cs.id, cs.total_cost
),
-- Per-recipient conversions from the ledger, aggregated BEFORE the group
-- fan-out. 0231: OWN-OFFER rows only — the split rows go to `moved` below. The
-- NOT EXISTS is the exact complement of the split predicate (same join path,
-- same org scoping), so every ledger row lands in exactly one of the two.
conv AS (
  SELECT ce.org_id, ce.stage_send_id,
    COUNT(*) FILTER (
      WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE is_purchase)
        AND ce.status IN ('pending', 'approved')
    )::bigint AS purchases,
    COALESCE(SUM(ce.revenue) FILTER (
      WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE counts_revenue)
        AND ce.status = 'approved'
    ), 0)::numeric(14,4) AS revenue,
    COALESCE(SUM(ce.revenue) FILTER (
      WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE counts_revenue)
        AND ce.status = 'pending'
    ), 0)::numeric(14,4) AS pending_revenue
  FROM public.conversion_events ce
  WHERE ce.stage_send_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.campaign_stages xs
      JOIN public.campaigns xc ON xc.id = xs.campaign_id AND xc.org_id = ce.org_id
      WHERE xs.id = ce.stage_id AND xs.org_id = ce.org_id
        AND ce.offer_id IS NOT NULL
        AND ce.offer_id IS DISTINCT FROM xc.offer_id
    )
  GROUP BY ce.org_id, ce.stage_send_id
),
-- ONE pass over the stage_sends x contact_contact_groups join: economics AND
-- list pressure. Reproduced from 0183 VERBATIM (0231 changes only what `conv`
-- holds) — this is the expensive part of the refresh and must not grow.
attr AS (
  SELECT camp.org_id, camp.offer_id, ccg.contact_group_id AS group_id,
    COUNT(*)::bigint                                             AS sends,
    SUM(COALESCE(r.per_send, 0))::numeric(14,4)                  AS cost,
    SUM(COALESCE(cv.revenue, 0))::numeric(14,4)                  AS revenue,
    SUM(COALESCE(cv.pending_revenue, 0))::numeric(14,4)          AS pending_revenue,
    SUM(COALESCE(cv.purchases, 0))::bigint                       AS sales,
    COUNT(*) FILTER (WHERE ss.sent_at >= now() - interval '7 days')::bigint  AS sent_7d,
    COUNT(*) FILTER (WHERE ss.sent_at >= now() - interval '30 days')::bigint AS sent_30d,
    COUNT(*) FILTER (WHERE ss.sent_at >= now() - interval '90 days')::bigint AS sent_90d
  FROM public.stage_sends ss
  JOIN public.campaign_stages cs ON cs.id = ss.stage_id
  JOIN public.offer_report_tracked_campaigns camp ON camp.id = cs.campaign_id
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = ss.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)
   AND ccg.org_id = camp.org_id
  LEFT JOIN rate r ON r.stage_id = ss.stage_id
  LEFT JOIN conv cv ON cv.stage_send_id = ss.id AND cv.org_id = camp.org_id
  WHERE ss.status = 'sent'
  GROUP BY camp.org_id, camp.offer_id, ccg.contact_group_id
),
-- 0231: the split ledger rows (35 on prod) — the complement of `conv`'s
-- filter, same join path. MATERIALIZED so the planner cannot push the
-- stage_sends primary-key lookups below this filter: measured on prod, letting
-- it look up all ~3.5K ledger rows first cost 4.4 s on a cold cache.
split_ce AS MATERIALIZED (
  SELECT ce.org_id, ce.offer_id, ce.stage_send_id, ce.event_type_id, ce.status, ce.revenue
  FROM public.conversion_events ce
  JOIN public.campaign_stages xs ON xs.id = ce.stage_id AND xs.org_id = ce.org_id
  JOIN public.campaigns xc ON xc.id = xs.campaign_id AND xc.org_id = ce.org_id
  WHERE ce.offer_id IS NOT NULL
    AND ce.offer_id IS DISTINCT FROM xc.offer_id
),
-- 0231: the split rows, placed in the same cells `attr` would have put them
-- in (same send -> stage -> tracked campaign path, same targeted-group rule,
-- same org guard as `cv.org_id = camp.org_id`), but under the CONVERSION's
-- offer. Starts from the ~3.5K-row ledger and reaches stage_sends by primary
-- key, so it costs milliseconds. Sends, cost and sent_* are 0: the traffic
-- stays with the sending campaign's offer.
moved AS (
  SELECT camp.org_id, ce.offer_id, ccg.contact_group_id AS group_id,
    0::bigint                                                    AS sends,
    0::numeric(14,4)                                             AS cost,
    COALESCE(SUM(ce.revenue) FILTER (
      WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE counts_revenue)
        AND ce.status = 'approved'
    ), 0)::numeric(14,4)                                         AS revenue,
    COALESCE(SUM(ce.revenue) FILTER (
      WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE counts_revenue)
        AND ce.status = 'pending'
    ), 0)::numeric(14,4)                                         AS pending_revenue,
    COUNT(*) FILTER (
      WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE is_purchase)
        AND ce.status IN ('pending', 'approved')
    )::bigint                                                    AS sales,
    0::bigint AS sent_7d, 0::bigint AS sent_30d, 0::bigint AS sent_90d
  FROM split_ce ce
  JOIN public.stage_sends ss ON ss.id = ce.stage_send_id
  JOIN public.campaign_stages cs ON cs.id = ss.stage_id
  JOIN public.offer_report_tracked_campaigns camp
    ON camp.id = cs.campaign_id AND camp.org_id = ce.org_id
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = ss.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)
   AND ccg.org_id = camp.org_id
  WHERE ss.status = 'sent'
  GROUP BY camp.org_id, ce.offer_id, ccg.contact_group_id
  -- Same rule as offer_split_amounts_v: a cell that moves nothing is not minted.
  HAVING COUNT(*) FILTER (
           WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE is_purchase)
             AND ce.status IN ('pending', 'approved')
         ) <> 0
      OR COALESCE(SUM(ce.revenue) FILTER (
           WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE counts_revenue)
             AND ce.status = 'approved'
         ), 0) <> 0
      OR COALESCE(SUM(ce.revenue) FILTER (
           WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE counts_revenue)
             AND ce.status = 'pending'
         ), 0) <> 0
),
-- The cells: own-offer traffic and conversions, plus the moved conversions.
-- A few thousand rows; the re-aggregation is free.
cells AS (
  SELECT u.org_id, u.offer_id, u.group_id,
    SUM(u.sends)::bigint                    AS sends,
    SUM(u.cost)::numeric(14,4)              AS cost,
    SUM(u.revenue)::numeric(14,4)           AS revenue,
    SUM(u.pending_revenue)::numeric(14,4)   AS pending_revenue,
    SUM(u.sales)::bigint                    AS sales,
    SUM(u.sent_7d)::bigint                  AS sent_7d,
    SUM(u.sent_30d)::bigint                 AS sent_30d,
    SUM(u.sent_90d)::bigint                 AS sent_90d
  FROM (
    SELECT org_id, offer_id, group_id, sends, cost, revenue, pending_revenue, sales,
           sent_7d, sent_30d, sent_90d
    FROM attr
    UNION ALL
    SELECT org_id, offer_id, group_id, sends, cost, revenue, pending_revenue, sales,
           sent_7d, sent_30d, sent_90d
    FROM moved
  ) u
  GROUP BY u.org_id, u.offer_id, u.group_id
),
cell_clicks AS (
  SELECT camp.org_id, camp.offer_id, ccg.contact_group_id AS group_id,
    COUNT(DISTINCT cc.contact_id)::bigint AS n
  FROM public.counted_clickers cc
  JOIN public.offer_report_tracked_campaigns camp ON camp.id = cc.campaign_id
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = cc.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)
   AND ccg.org_id = camp.org_id
  GROUP BY camp.org_id, camp.offer_id, ccg.contact_group_id
),
cell_optouts AS (
  SELECT camp.org_id, camp.offer_id, ccg.contact_group_id AS group_id,
    COUNT(DISTINCT oa.opt_out_id)::bigint AS n
  FROM public.opt_out_attributions oa
  JOIN public.stage_sends ss ON ss.id = oa.stage_send_id
  JOIN public.campaign_stages cs ON cs.id = oa.stage_id
  JOIN public.offer_report_tracked_campaigns camp ON camp.id = cs.campaign_id
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = ss.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)
   AND ccg.org_id = camp.org_id
  GROUP BY camp.org_id, camp.offer_id, ccg.contact_group_id
),
-- FRESH POOL — 0183's definition; see 0133's header. 0231: the offer list
-- comes from `cells`, not `attr`, so an offer that appears only through moved
-- conversions still gets a fresh pool on its rows.
fresh AS (
  WITH sendable AS (
    SELECT ccg.contact_group_id AS group_id, ct.org_id, ct.id AS contact_id
    FROM public.contacts ct
    JOIN public.contact_contact_groups ccg
      ON ccg.contact_id = ct.id AND ccg.org_id = ct.org_id
    WHERE ct.messaging_status = 'eligible'
      AND NOT EXISTS (
        SELECT 1 FROM public.opt_outs o
        WHERE o.contact_id = ct.id AND o.org_id = ct.org_id
      )
  ),
  sendable_per_group AS (
    SELECT org_id, group_id, COUNT(*)::bigint AS n FROM sendable GROUP BY org_id, group_id
  ),
  exposed_per_offer_group AS (
    SELECT s.org_id, e.offer_id, s.group_id, COUNT(*)::bigint AS n
    FROM sendable s
    JOIN public.offer_exposures e ON e.contact_id = s.contact_id
    GROUP BY s.org_id, e.offer_id, s.group_id
  )
  SELECT o.org_id, o.offer_id, g.group_id,
         (g.n - COALESCE(x.n, 0))::bigint AS fresh_pool
  FROM (SELECT DISTINCT org_id, offer_id FROM cells) o
  JOIN sendable_per_group g ON g.org_id = o.org_id
  LEFT JOIN exposed_per_offer_group x
    ON x.org_id = o.org_id AND x.offer_id = o.offer_id AND x.group_id = g.group_id
)
SELECT a.org_id, a.offer_id, a.group_id, cg.name AS group_name,
  a.sends, a.revenue, a.pending_revenue, a.sales,
  COALESCE(ck.n, 0)::bigint AS clicks,
  a.cost,
  COALESCE(oo.n, 0)::bigint AS optouts,
  a.sent_7d, a.sent_30d, a.sent_90d,
  COALESCE(f.fresh_pool, 0) AS fresh_pool
FROM cells a
LEFT JOIN public.contact_groups cg ON cg.id = a.group_id AND cg.org_id = a.org_id
LEFT JOIN cell_clicks  ck ON ck.org_id = a.org_id AND ck.offer_id = a.offer_id AND ck.group_id = a.group_id
LEFT JOIN cell_optouts oo ON oo.org_id = a.org_id AND oo.offer_id = a.offer_id AND oo.group_id = a.group_id
LEFT JOIN fresh f ON f.org_id = a.org_id AND f.offer_id = a.offer_id AND f.group_id = a.group_id
WITH NO DATA;
--> statement-breakpoint
-- REFRESH ... CONCURRENTLY (the twice-daily cron) requires a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS offer_group_report_v2_mv_key_uniq
  ON public.offer_group_report_v2_mv (org_id, offer_id, group_id);
--> statement-breakpoint
REVOKE ALL ON public.offer_group_report_v2_mv FROM anon, authenticated;
--> statement-breakpoint
-- 0183's Audience Stats definition, reading the v2 cells. Unchanged numbers by
-- construction: the moved money stays inside its group.
CREATE MATERIALIZED VIEW IF NOT EXISTS public.audience_report_group_totals_v2_mv AS
WITH sums AS (
  SELECT org_id, group_id,
    SUM(sends)::bigint          AS sends,
    SUM(revenue)::numeric(14,4) AS revenue,
    SUM(pending_revenue)::numeric(14,4) AS pending_revenue,
    SUM(sales)::bigint          AS sales,
    SUM(cost)::numeric(14,4)    AS cost,
    SUM(sent_7d)::bigint        AS sent_7d,
    SUM(sent_30d)::bigint       AS sent_30d,
    SUM(sent_90d)::bigint       AS sent_90d
  FROM public.offer_group_report_v2_mv
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
  s.sends, s.revenue, s.pending_revenue, s.sales,
  COALESCE(k.n, 0)::bigint AS clicks,
  s.cost,
  COALESCE(x.n, 0)::bigint AS optouts,
  s.sent_7d, s.sent_30d, s.sent_90d
FROM sums s
LEFT JOIN group_clicks  k ON k.org_id = s.org_id AND k.group_id = s.group_id
LEFT JOIN group_optouts x ON x.org_id = s.org_id AND x.group_id = s.group_id
WITH NO DATA;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS audience_report_group_totals_v2_mv_key_uniq
  ON public.audience_report_group_totals_v2_mv (org_id, group_id);
--> statement-breakpoint
REVOKE ALL ON public.audience_report_group_totals_v2_mv FROM anon, authenticated;
--> statement-breakpoint
CREATE MATERIALIZED VIEW IF NOT EXISTS public.offer_report_offer_totals_v2_mv AS
-- 0231: the stage-grain half with the splits moved — subtracted from the
-- campaign's offer, added to the conversion's offer (splitStageMetrics' twin).
-- The UNION ALL is what gives a target offer with no campaigns of its own a
-- footer row; sends / cost / opt-outs are 0 on the split legs, so those columns
-- are 0183's numbers exactly.
WITH base AS (
  SELECT u.org_id, u.offer_id,
    SUM(u.sends)::bigint                        AS sends,
    SUM(u.revenue)::numeric(14,4)               AS revenue,
    SUM(u.sales)::bigint                        AS sales,
    SUM(u.cost)::numeric(14,4)                  AS cost,
    SUM(u.optouts)::bigint                      AS optouts,
    COALESCE(bool_or(u.has_manual_stages), false) AS has_manual_stages
  FROM (
    SELECT e.org_id, e.offer_id, e.sends, e.revenue, e.sales, e.cost, e.optouts,
           e.has_manual_stages
    FROM public.offer_report_campaign_econ e
    WHERE e.offer_id IS NOT NULL
    UNION ALL
    SELECT s.org_id, s.campaign_offer_id, 0, -s.revenue, -s.sales, 0, 0, NULL::boolean
    FROM public.offer_split_amounts_v s
    WHERE s.campaign_offer_id IS NOT NULL
    UNION ALL
    SELECT s.org_id, s.offer_id, 0, s.revenue, s.sales, 0, 0, NULL::boolean
    FROM public.offer_split_amounts_v s
    WHERE s.campaign_offer_id IS NOT NULL
  ) u
  GROUP BY u.org_id, u.offer_id
),
-- Per-recipient conversions from the ledger. 0231: OWN-OFFER rows only, the
-- same NOT EXISTS as in offer_group_report_v2_mv.
conv AS (
  SELECT ce.org_id, ce.stage_send_id,
    COUNT(*) FILTER (
      WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE is_purchase)
        AND ce.status IN ('pending', 'approved')
    )::bigint AS purchases,
    COALESCE(SUM(ce.revenue) FILTER (
      WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE counts_revenue)
        AND ce.status = 'approved'
    ), 0)::numeric(14,4) AS revenue,
    COALESCE(SUM(ce.revenue) FILTER (
      WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE counts_revenue)
        AND ce.status = 'pending'
    ), 0)::numeric(14,4) AS pending_revenue
  FROM public.conversion_events ce
  WHERE ce.stage_send_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.campaign_stages xs
      JOIN public.campaigns xc ON xc.id = xs.campaign_id AND xc.org_id = ce.org_id
      WHERE xs.id = ce.stage_id AND xs.org_id = ce.org_id
        AND ce.offer_id IS NOT NULL
        AND ce.offer_id IS DISTINCT FROM xc.offer_id
    )
  GROUP BY ce.org_id, ce.stage_send_id
),
-- 0183's `attributable` VERBATIM (the footer's stage_sends pass), over the
-- own-offer `conv`. DISTINCT sends — see 0183.
attributable_own AS (
  SELECT ds.org_id, ds.offer_id,
    COUNT(*)::bigint                       AS n,
    SUM(ds.revenue)::numeric(14,4)         AS revenue,
    SUM(ds.pending_revenue)::numeric(14,4) AS pending_revenue,
    SUM(ds.purchases)::bigint              AS sales
  FROM (
    SELECT ss.id,
           COALESCE(cv.revenue, 0)::numeric(14,4)         AS revenue,
           COALESCE(cv.pending_revenue, 0)::numeric(14,4) AS pending_revenue,
           COALESCE(cv.purchases, 0)::bigint              AS purchases,
           camp.org_id, camp.offer_id
    FROM public.stage_sends ss
    JOIN public.campaign_stages cs ON cs.id = ss.stage_id
    JOIN public.offer_report_tracked_campaigns camp ON camp.id = cs.campaign_id
    LEFT JOIN conv cv ON cv.stage_send_id = ss.id AND cv.org_id = camp.org_id
    WHERE ss.status = 'sent'
      AND EXISTS (
        SELECT 1 FROM public.contact_contact_groups ccg
        WHERE ccg.contact_id = ss.contact_id
          AND ccg.contact_group_id = ANY(camp.gids)
          AND ccg.org_id = camp.org_id
      )
  ) ds
  GROUP BY ds.org_id, ds.offer_id
),
-- 0231: the split ledger rows (35 on prod) — the complement of `conv`'s
-- filter, same join path. MATERIALIZED so the planner cannot push the
-- stage_sends primary-key lookups below this filter: measured on prod, letting
-- it look up all ~3.5K ledger rows first cost 4.4 s on a cold cache.
split_ce AS MATERIALIZED (
  SELECT ce.org_id, ce.offer_id, ce.stage_send_id, ce.event_type_id, ce.status, ce.revenue
  FROM public.conversion_events ce
  JOIN public.campaign_stages xs ON xs.id = ce.stage_id AND xs.org_id = ce.org_id
  JOIN public.campaigns xc ON xc.id = xs.campaign_id AND xc.org_id = ce.org_id
  WHERE ce.offer_id IS NOT NULL
    AND ce.offer_id IS DISTINCT FROM xc.offer_id
),
-- 0231: the split rows that `attributable` would have counted (sent,
-- group-targeted send of a tracked campaign — the same EXISTS), under the
-- conversion's offer, with n = 0 (the send stays with its campaign's offer).
-- One row per CONVERSION, not per group: the EXISTS keeps it at the send grain.
attributable_moved AS (
  SELECT camp.org_id, ce.offer_id,
    0::bigint AS n,
    COALESCE(SUM(ce.revenue) FILTER (
      WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE counts_revenue)
        AND ce.status = 'approved'
    ), 0)::numeric(14,4) AS revenue,
    COALESCE(SUM(ce.revenue) FILTER (
      WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE counts_revenue)
        AND ce.status = 'pending'
    ), 0)::numeric(14,4) AS pending_revenue,
    COUNT(*) FILTER (
      WHERE ce.event_type_id IN (SELECT id FROM public.event_types WHERE is_purchase)
        AND ce.status IN ('pending', 'approved')
    )::bigint AS sales
  FROM split_ce ce
  JOIN public.stage_sends ss ON ss.id = ce.stage_send_id
  JOIN public.campaign_stages cs ON cs.id = ss.stage_id
  JOIN public.offer_report_tracked_campaigns camp
    ON camp.id = cs.campaign_id AND camp.org_id = ce.org_id
  WHERE ss.status = 'sent'
    AND EXISTS (
      SELECT 1 FROM public.contact_contact_groups ccg
      WHERE ccg.contact_id = ss.contact_id
        AND ccg.contact_group_id = ANY(camp.gids)
        AND ccg.org_id = camp.org_id
    )
  GROUP BY camp.org_id, ce.offer_id
),
attributable AS (
  SELECT u.org_id, u.offer_id,
    SUM(u.n)::bigint                       AS n,
    SUM(u.revenue)::numeric(14,4)          AS revenue,
    SUM(u.pending_revenue)::numeric(14,4)  AS pending_revenue,
    SUM(u.sales)::bigint                   AS sales
  FROM (
    SELECT org_id, offer_id, n, revenue, pending_revenue, sales FROM attributable_own
    UNION ALL
    SELECT org_id, offer_id, n, revenue, pending_revenue, sales FROM attributable_moved
  ) u
  GROUP BY u.org_id, u.offer_id
),
offer_tracked AS (
  SELECT c.org_id, c.offer_id, COUNT(DISTINCT cc.contact_id)::bigint AS n
  FROM public.counted_clickers cc
  JOIN public.campaigns c ON c.id = cc.campaign_id
  WHERE c.offer_id IS NOT NULL
  GROUP BY c.org_id, c.offer_id
),
offer_manual AS (
  SELECT c.org_id, c.offer_id, SUM(COALESCE(k.visits, 0))::bigint AS n
  FROM public.campaign_stages cs
  JOIN public.campaigns c ON c.id = cs.campaign_id
  LEFT JOIN (
    SELECT stage_id, SUM(visit_clicks_clean)::int AS visits
    FROM public.keitaro_stage_results GROUP BY stage_id
  ) k ON k.stage_id = cs.id
  WHERE cs.sent_at IS NOT NULL AND c.offer_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.counted_clickers x WHERE x.stage_id = cs.id)
  GROUP BY c.org_id, c.offer_id
)
SELECT b.org_id, b.offer_id, b.sends, b.revenue, b.sales,
  (COALESCE(ot.n, 0) + COALESCE(om.n, 0))::bigint AS clicks,
  b.cost, b.optouts, b.has_manual_stages,
  COALESCE(a.n, 0)::bigint                      AS attributable_sends,
  COALESCE(a.revenue, 0)::numeric(14,4)         AS attributable_revenue,
  COALESCE(a.sales, 0)::bigint                  AS attributable_sales,
  COALESCE(a.pending_revenue, 0)::numeric(14,4) AS attributable_pending_revenue,
  (b.sends - COALESCE(a.n, 0))::bigint          AS unattributed_sends
FROM base b
LEFT JOIN attributable  a  ON a.org_id  = b.org_id AND a.offer_id  = b.offer_id
LEFT JOIN offer_tracked ot ON ot.org_id = b.org_id AND ot.offer_id = b.offer_id
LEFT JOIN offer_manual  om ON om.org_id = b.org_id AND om.offer_id = b.offer_id
WITH NO DATA;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS offer_report_offer_totals_v2_mv_key_uniq
  ON public.offer_report_offer_totals_v2_mv (org_id, offer_id);
--> statement-breakpoint
REVOKE ALL ON public.offer_report_offer_totals_v2_mv FROM anon, authenticated;
--> statement-breakpoint
-- Seeded NULL per the 0093/0132 convention: NULL = "not yet refreshed". The
-- refresh loop only UPDATEs these rows, so they must exist. The fill script
-- stamps them; until then the reports would read "not yet refreshed" — which is
-- why the reader switch deploys only after the fill.
INSERT INTO public.report_refresh_log (view_name, refreshed_at)
VALUES ('offer_group_report_v2_mv', NULL),
       ('audience_report_group_totals_v2_mv', NULL),
       ('offer_report_offer_totals_v2_mv', NULL)
ON CONFLICT (view_name) DO NOTHING;
