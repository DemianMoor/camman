-- Migration 0132: attribute the offer group report PER RECIPIENT.
--
-- 0128 fixed HOW the clicker count was aggregated. It did not fix WHO a row is
-- about. `offer_group_report_mv` builds its economics with
-- `CROSS JOIN LATERAL unnest(group_ids)`, so a campaign that targeted 12 groups
-- contributes its ENTIRE sends/revenue/sales/cost/optouts to all 12 rows. And
-- 0128's own `cell_tracked` deduplicated clickers within a cell but never
-- required the clicker to be a MEMBER of the group -- so the EPC denominator is
-- replicated alongside its numerator.
--
-- Measured on offer 96 (Kinzeno 15013 Roller), 2026-08-13: 4 campaigns, 88,536
-- real sends, twelve group rows of which seven were byte-identical at 78,765
-- sends / 24 sales / $991.38. The footer summed those rows and read 904,926 --
-- 10.2x the truth. Five of twelve rows flip from above break-even to below once
-- attribution is real, and AstroEnergy goes from +$696 profit to -$74.
--
-- THE RULE: a group row counts the sends that actually reached contacts in that
-- group -- `stage_sends` joined to `contact_contact_groups` on the recipient,
-- restricted to groups the campaign targeted. Full count, not a fractional
-- share: the ratios then answer "of the messages sent to Memory members, what
-- did those recipients return", which is the question the screen exists for.
-- The price is that the columns DO NOT FOOT -- a contact in three of an offer's
-- groups is one send and three group-sends (+18.7% on sends, +37.5% on revenue
-- for offer 96). That is what non-additivity looks like on screen, and it is the
-- same rule 0128 applied to clicks, now applied to six columns.
--
-- COST cannot be read per recipient: `stage_sends.cost_per_sms` is NULL on
-- 967,276 of 2,954,929 sent rows (32.7%), covering only $19,879 of $32,440. It
-- is derived from the stage instead: `total_cost / (sent rows of that stage)`.
--
-- SCOPE FILTERS MIRROR `offer_report_campaign_econ` PER COLUMN, because that
-- view is not internally consistent:
--   tracked sends (`ts`)  -- status='sent', NO stage-level sent_at/archived_at
--   manual sends / cost   -- sent_at IS NOT NULL AND archived_at IS NULL
--   sends column          -- CASE WHEN link_mode='tracked' THEN ts ELSE mc END
-- So `attr` carries no stage-level filter (mirrors ts) while `rate` filters
-- sent_at/archived_at (mirrors cst), and `camp` is restricted to
-- link_mode='tracked'. That last one is load-bearing: campaign 110 has
-- sms_count=0 across its stages but 889 real stage_sends rows, so counting it
-- would put 889 sends in group rows that the footer never counted -- a
-- campaign-grain residual of -889, masked only because offer 58 is large enough
-- to absorb it. Restricting to tracked takes the minimum residual to exactly 0.
--
-- MANUAL-MODE CLICK FALLBACK IS GONE FROM GROUP ROWS, provably: of 938 sent
-- stages, 22 have per-recipient sends but no counted_clickers, and all 22 have
-- ZERO Keitaro visits. Every one of the 1,884 fallback visits sits on the 59
-- externally-sent stages, i.e. the same bucket as the un-attributable sends. So
-- `has_manual_stages` can never be true at group grain; it moves to the offer
-- totals. 33 of 80 cells carried that mixed-unit flag before this.
--
-- ~4.9% of sends (152,929 of 3,135,015 on this basis) cannot reach any group
-- row -- sends performed entirely outside the app with a hand-recorded
-- sms_count. 6 of 21 offers are 100% external and now render NO group rows.
-- `offer_report_offer_totals_mv` exists per offer regardless, so the footer and
-- the "recorded outside the app" note still render for them.
--
-- `offer_report_campaign_econ` and `offer_report_org_summary_mv` are UNCHANGED:
-- the benchmark was already campaign-grain and correct. Note the bias direction
-- is the opposite of the EPC workstream -- there the benchmark was the inflated
-- half; here it is the only correct one.
DROP MATERIALIZED VIEW IF EXISTS public.offer_group_report_mv;
--> statement-breakpoint
DROP VIEW IF EXISTS public.offer_report_tracked_campaigns;
--> statement-breakpoint
-- The attribution universe, defined ONCE. Both matviews below select from this
-- rather than each carrying its own copy: if the two ever diverged,
-- `attributable_sends` and the group rows would be computed over different
-- campaign sets and the residual `sends - attributable_sends` could go negative
-- while every individual query still looked correct. That scope mismatch is
-- precisely the failure this migration exists to prevent, so it is made
-- structurally impossible instead of guarded by a comment. Postgres inlines a
-- plain view like this one, so there is no planning or execution cost.
CREATE VIEW public.offer_report_tracked_campaigns AS
  SELECT c.id, c.org_id, c.offer_id, c.audience_contact_group_ids AS gids
  FROM public.campaigns c
  WHERE c.offer_id IS NOT NULL
    AND c.link_mode = 'tracked'
    AND EXISTS (SELECT 1 FROM public.campaign_stages s
                WHERE s.campaign_id = c.id AND s.sent_at IS NOT NULL);
--> statement-breakpoint
CREATE MATERIALIZED VIEW public.offer_report_offer_totals_mv AS
WITH base AS (
  SELECT e.org_id, e.offer_id,
    SUM(e.sends)::bigint          AS sends,
    SUM(e.revenue)::numeric(14,4) AS revenue,
    SUM(e.sales)::bigint          AS sales,
    SUM(e.cost)::numeric(14,4)    AS cost,
    SUM(e.optouts)::bigint        AS optouts,
    bool_or(e.has_manual_stages)  AS has_manual_stages
  FROM public.offer_report_campaign_econ e
  WHERE e.offer_id IS NOT NULL
  GROUP BY e.org_id, e.offer_id
),
-- DISTINCT sends, not the sum of the group cells: that sum is non-additive by
-- design and using it here would reintroduce the defect this migration removes.
attributable AS (
  SELECT camp.org_id, camp.offer_id, COUNT(DISTINCT ss.id)::bigint AS n
  FROM public.stage_sends ss
  JOIN public.offer_report_tracked_campaigns camp ON camp.id = ss.campaign_id
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = ss.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)
  WHERE ss.status = 'sent'
  GROUP BY camp.org_id, camp.offer_id
),
-- Offer-grain clicks: DISTINCT contacts, plus manual-stage visits which have no
-- set behind them to deduplicate. Same decomposition 0128 established.
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
  (b.sends - COALESCE(a.n, 0))::bigint          AS unattributed_sends
FROM base b
LEFT JOIN attributable  a  ON a.org_id  = b.org_id AND a.offer_id  = b.offer_id
LEFT JOIN offer_tracked ot ON ot.org_id = b.org_id AND ot.offer_id = b.offer_id
LEFT JOIN offer_manual  om ON om.org_id = b.org_id AND om.offer_id = b.offer_id;
--> statement-breakpoint
CREATE UNIQUE INDEX offer_report_offer_totals_mv_key_uniq
  ON public.offer_report_offer_totals_mv (org_id, offer_id);
--> statement-breakpoint
CREATE MATERIALIZED VIEW public.offer_group_report_mv AS
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
-- ONE pass over the stage_sends x contact_contact_groups join: economics AND
-- list pressure. That join already ran for the list-pressure columns alone, so
-- the economics ride along at ~zero marginal cost (9.53s -> 9.96s measured).
attr AS (
  SELECT camp.org_id, camp.offer_id, ccg.contact_group_id AS group_id,
    COUNT(*)::bigint                                        AS sends,
    SUM(COALESCE(r.per_send, 0))::numeric(14,4)             AS cost,
    SUM(COALESCE(ss.sale_revenue, 0))::numeric(14,4)        AS revenue,
    COUNT(*) FILTER (WHERE ss.converted_at IS NOT NULL)::bigint AS sales,
    COUNT(*) FILTER (WHERE ss.sent_at >= now() - interval '7 days')::bigint  AS sent_7d,
    COUNT(*) FILTER (WHERE ss.sent_at >= now() - interval '30 days')::bigint AS sent_30d,
    COUNT(*) FILTER (WHERE ss.sent_at >= now() - interval '90 days')::bigint AS sent_90d
  FROM public.stage_sends ss
  JOIN public.offer_report_tracked_campaigns camp ON camp.id = ss.campaign_id
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = ss.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)
  LEFT JOIN rate r ON r.stage_id = ss.stage_id
  WHERE ss.status = 'sent'
  GROUP BY camp.org_id, camp.offer_id, ccg.contact_group_id
),
-- Clicks and opt-outs gain the membership predicate 0128 omitted, deduplicated
-- at the CELL's grain: someone who clicked three campaigns of this offer, all
-- targeting this group, is one clicker in this cell.
cell_clicks AS (
  SELECT camp.org_id, camp.offer_id, ccg.contact_group_id AS group_id,
    COUNT(DISTINCT cc.contact_id)::bigint AS n
  FROM public.counted_clickers cc
  JOIN public.offer_report_tracked_campaigns camp ON camp.id = cc.campaign_id
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = cc.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)
  GROUP BY camp.org_id, camp.offer_id, ccg.contact_group_id
),
cell_optouts AS (
  SELECT camp.org_id, camp.offer_id, ccg.contact_group_id AS group_id,
    COUNT(DISTINCT oa.opt_out_id)::bigint AS n
  FROM public.opt_out_attributions oa
  JOIN public.stage_sends ss ON ss.id = oa.stage_send_id
  JOIN public.offer_report_tracked_campaigns camp ON camp.id = ss.campaign_id
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = ss.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)
  GROUP BY camp.org_id, camp.offer_id, ccg.contact_group_id
),
-- Unchanged from 0128: contacts in the group with no 'sent' row in 90 days,
-- across ALL offers, no opt-out filter.
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
SELECT a.org_id, a.offer_id, a.group_id, cg.name AS group_name,
  a.sends, a.revenue, a.sales,
  COALESCE(ck.n, 0)::bigint AS clicks,
  a.cost,
  COALESCE(oo.n, 0)::bigint AS optouts,
  a.sent_7d, a.sent_30d, a.sent_90d,
  COALESCE(f.fresh_pool, 0) AS fresh_pool
FROM attr a
LEFT JOIN public.contact_groups cg ON cg.id = a.group_id
LEFT JOIN cell_clicks  ck ON ck.org_id = a.org_id AND ck.offer_id = a.offer_id AND ck.group_id = a.group_id
LEFT JOIN cell_optouts oo ON oo.org_id = a.org_id AND oo.offer_id = a.offer_id AND oo.group_id = a.group_id
LEFT JOIN fresh f ON f.org_id = a.org_id AND f.group_id = a.group_id;
--> statement-breakpoint
CREATE UNIQUE INDEX offer_group_report_mv_key_uniq
  ON public.offer_group_report_mv (org_id, offer_id, group_id);
--> statement-breakpoint
INSERT INTO public.report_refresh_log (view_name, refreshed_at)
VALUES ('offer_report_offer_totals_mv', now())
ON CONFLICT (view_name) DO UPDATE SET refreshed_at = now();
