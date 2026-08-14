-- Migration 0132: attribute the offer group report PER RECIPIENT.
--
-- -- DEPLOY ORDERING -- read before applying --------------------------------
-- This migration is DESTRUCTIVE against the reader currently deployed:
-- `offer_group_report_mv` loses `has_manual_stages`, `offer_clicks`, and
-- `offer_has_manual`, all three of which lib/reporting/offer-group-report.ts
-- SELECTs today. There is an unavoidable window between this migration
-- applying and the updated reader's deploy landing, during which
-- /offers/[id]/report errors with `column "has_manual_stages" does not
-- exist`. Keep that window short and apply this deliberately -- watch the
-- reader deploy land, not as an unattended/background step.
--
-- APPLY THIS MIGRATION BEFORE MERGING/DEPLOYING THIS BRANCH -- this project's
-- documented convention (CLAUDE.md section 14: migrations are applied before
-- the code that depends on them). Getting the order backwards fails
-- differently in each direction:
--   migration-first -- the OLD reader (pre-this-branch code, still deployed)
--     500s on /offers/[id]/report as described above, until the code deploy
--     lands.
--   code-first -- the NEW reader queries `offer_report_offer_totals_mv`, which
--     doesn't exist yet, so the page 500s immediately; the twice-daily refresh
--     cron (`refreshOfferGroupReport()`, lib/reporting/offer-group-report.ts)
--     also throws on that matview's refresh, and the invocation ends in a
--     Tier-1 alert every run until the migration applies. That refresh runs
--     LAST specifically so the two pre-existing matviews still refresh before
--     the throw, instead of neither running at all.
--
-- SECURITY: `offer_report_tracked_campaigns` (new below) and
-- `offer_report_campaign_econ` (0093, re-secured by 0113) both get
-- `security_invoker = true` in this migration -- see the ALTER VIEW
-- statements below. Any future DROP VIEW / CREATE VIEW on either object MUST
-- re-apply that option, or it silently reopens the RLS-bypass advisor ERROR
-- this migration closes -- 0126 and 0128 already did this once, by omission.
-- ----------------------------------------------------------------------------
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
-- ATTRIBUTABLE REVENUE AND SALES -- same basis gap as sends, made measurable.
-- `revenue`/`sales` in `base` come from `offer_report_campaign_econ`, sourced
-- from `keitaro_stage_results.revenue` and GREATEST(keitaro sales,
-- stage_manual_sales.delta) -- a PER-STAGE AGGREGATE basis. The group rows
-- (and now `attributable_revenue`/`attributable_sales` below) compute
-- SUM(stage_sends.sale_revenue) and COUNT(*) FILTER (WHERE converted_at IS
-- NOT NULL) -- a PER-RECIPIENT basis. `attributable_revenue` sits beside
-- `revenue`, which is Keitaro revenue alone, and covers ~97% of it org-wide
-- (54,844 / 56,338). `attributable_sales` sits beside `sales`, which is
-- GREATEST(keitaro sales, stage_manual_sales.delta) -- a LARGER denominator
-- than Keitaro sales alone, because it also counts hand-entered sales with no
-- per-recipient conversion behind them. Measured on this migration's 21-offer
-- verification table: campaign-grain sales 908, attributable sales 815 --
-- ~90% (89.8%) of GREATEST(keitaro, manual), not the ~96% a Keitaro-sales-only
-- comparison would read. A stage whose sales are entirely
-- hand-entered (stage_manual_sales, with no per-recipient conversion behind
-- it) contributes to the footer and zero to any group row -- the same "reads
-- different from the benchmark by construction" defect this workstream exists
-- to remove, this time pointing at the group rows instead of the benchmark.
-- Left unmeasured, every group row would carry a silent haircut against the
-- total beside it. `attributable_revenue`/`attributable_sales` exist so the
-- gap can be SEEN (compare directly against `revenue`/`sales`) rather than
-- inferred. No `unattributed_revenue`/`unattributed_sales` columns: unlike
-- `sends`, the two bases are not a whole-and-part relationship -- they come
-- from different underlying sources, not a subset -- so subtracting one from
-- the other would imply a precision the data does not have.
--
-- `offer_report_campaign_econ` and `offer_report_org_summary_mv` are UNCHANGED:
-- the benchmark was already campaign-grain and correct. Note the bias direction
-- is the opposite of the EPC workstream -- there the benchmark was the inflated
-- half; here it is the only correct one.
DROP MATERIALIZED VIEW IF EXISTS public.offer_group_report_mv;
--> statement-breakpoint
DROP MATERIALIZED VIEW IF EXISTS public.offer_report_offer_totals_mv;
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
-- security_invoker = true: see "SECURITY" in the header. Without this, the
-- view runs as its (postgres) owner and RLS on campaigns does not apply,
-- exposing every org's campaign id -> org_id -> offer_id -> targeted group
-- ids to anon/authenticated over /rest/v1/offer_report_tracked_campaigns.
ALTER VIEW public.offer_report_tracked_campaigns SET (security_invoker = true);
--> statement-breakpoint
-- Re-asserting what 0113 set on this view and 0126/0128 each silently
-- dropped by DROP VIEW + CREATE VIEW without carrying the option forward.
-- offer_report_campaign_econ is not otherwise touched by this migration --
-- this ALTER exists purely to close that regression while we're here.
ALTER VIEW public.offer_report_campaign_econ SET (security_invoker = true);
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
-- Membership is tested as EXISTS rather than a JOIN so a recipient who belongs
-- to several of the campaign's targeted groups still contributes exactly one
-- row here -- joining contact_contact_groups directly (as `attr` below does
-- for the group cells) would fan revenue/sales out across each matching group,
-- reintroducing the same defect at the offer grain instead of the group grain.
attributable AS (
  SELECT ds.org_id, ds.offer_id,
    COUNT(*)::bigint                                            AS n,
    SUM(ds.sale_revenue)::numeric(14,4)                         AS revenue,
    COUNT(*) FILTER (WHERE ds.converted_at IS NOT NULL)::bigint AS sales
  FROM (
    SELECT ss.id, ss.sale_revenue, ss.converted_at,
           camp.org_id, camp.offer_id
    FROM public.stage_sends ss
    -- Campaign resolved via the send's STAGE, matching
    -- offer_report_campaign_econ (the footer's source) -- not ss.campaign_id,
    -- the denormalized column. Sharing the SET (offer_report_tracked_campaigns)
    -- but not the join PATH would let a send whose campaign_id disagrees with
    -- its stage_id's campaign land its revenue/sales on the wrong offer while
    -- `sends` still (correctly) excludes it, which could drive
    -- unattributed_sends negative. `attr` in offer_group_report_mv shares this
    -- same path below, for the same reason.
    JOIN public.campaign_stages cs ON cs.id = ss.stage_id
    JOIN public.offer_report_tracked_campaigns camp ON camp.id = cs.campaign_id
    WHERE ss.status = 'sent'
      -- org_id checked explicitly even though contact_group_id is already
      -- scoped to camp.gids (a single org's campaign): defense-in-depth
      -- against the project's #1 rule (multi-tenancy) if a
      -- contact_contact_groups row is ever mis-tagged. Changes no rows today.
      AND EXISTS (
        SELECT 1 FROM public.contact_contact_groups ccg
        WHERE ccg.contact_id = ss.contact_id
          AND ccg.contact_group_id = ANY(camp.gids)
          AND ccg.org_id = camp.org_id
      )
  ) ds
  GROUP BY ds.org_id, ds.offer_id
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
  COALESCE(a.revenue, 0)::numeric(14,4)         AS attributable_revenue,
  COALESCE(a.sales, 0)::bigint                  AS attributable_sales,
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
-- list pressure. The marginal COST is ~zero because that join already ran for
-- the list-pressure columns alone (9.53s -> 9.96s measured) -- but the
-- POPULATION is not unchanged. 0128's `lp` CTE joined contact_contact_groups
-- on contact_id only, with three narrowings absent versus here: no
-- `= ANY(gids)` restriction to the groups the campaign actually targeted, no
-- `link_mode = 'tracked'` filter, and no requirement that the campaign have
-- EXISTS a stage with sent_at IS NOT NULL -- so sent_7d/30d/90d counted every
-- send of the offer that reached a member of group X whether or not the
-- campaign targeted X, whether or not it was tracked, and whether or not it
-- had actually sent. Here they share the same `offer_report_tracked_campaigns`
-- / `ANY(camp.gids)` scope as the economics columns, so sent_7d/30d/90d are
-- now a strict SUBSET of their 0128 values. Intentional and approved -- see
-- the header.
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
  -- Campaign resolved via the send's STAGE, matching offer_report_campaign_econ
  -- and `attributable` above -- not ss.campaign_id. See the comment there.
  JOIN public.campaign_stages cs ON cs.id = ss.stage_id
  JOIN public.offer_report_tracked_campaigns camp ON camp.id = cs.campaign_id
  -- org_id checked explicitly (not just contact_group_id = ANY(camp.gids)):
  -- defense-in-depth against a mis-tagged contact_contact_groups row leaking
  -- another org's data into this org's report. Changes no rows today; same
  -- reasoning as `attributable` above and the two CTEs below.
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = ss.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)
   AND ccg.org_id = camp.org_id
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
   AND ccg.org_id = camp.org_id
  GROUP BY camp.org_id, camp.offer_id, ccg.contact_group_id
),
-- Campaign resolved via oa.stage_id -> campaign_stages, matching the footer's
-- own opt-out subquery in offer_report_campaign_econ exactly (it joins
-- opt_out_attributions to campaign_stages, never touches stage_sends for the
-- campaign). stage_sends is kept only to get from the attribution to the
-- recipient's contact_id.
--
-- ASYMMETRY: oa.stage_send_id is nullable by design (an attribution survives
-- its send row being pruned). Such rows have no recipient, so they genuinely
-- cannot be placed in a group -- but the footer's oa.stage_id path keeps them
-- regardless. So group opt-outs can fall short of the footer for a reason no
-- other column here has: not a scope difference, but rows this join can never
-- reach.
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
-- org_id restored: 0093 had `cg.org_id = e.org_id` here; 0126/0128 dropped it
-- on drop/recreate. Defense-in-depth against a mis-tagged group id crossing
-- an org boundary. Changes no rows today.
LEFT JOIN public.contact_groups cg ON cg.id = a.group_id AND cg.org_id = a.org_id
LEFT JOIN cell_clicks  ck ON ck.org_id = a.org_id AND ck.offer_id = a.offer_id AND ck.group_id = a.group_id
LEFT JOIN cell_optouts oo ON oo.org_id = a.org_id AND oo.offer_id = a.offer_id AND oo.group_id = a.group_id
LEFT JOIN fresh f ON f.org_id = a.org_id AND f.group_id = a.group_id;
--> statement-breakpoint
CREATE UNIQUE INDEX offer_group_report_mv_key_uniq
  ON public.offer_group_report_mv (org_id, offer_id, group_id);
--> statement-breakpoint
-- Seeded NULL, not now(): CREATE MATERIALIZED VIEW ... AS <query> populates
-- the view immediately -- there is no WITH NO DATA here -- so it holds real
-- data the moment this migration applies; NULL does not mean the view is
-- empty. NULL means "as-of unknown": stamping now() here would claim the
-- data is as current as the twice-daily cron implies, when in fact nothing
-- has refreshed it via the cron since apply. Same convention as 0093's seed
-- of offer_group_report_mv / offer_report_org_summary_mv. Unlike that row,
-- this one is never read for the page's "Data as of" banner --
-- getOfferGroupReport() only reads offer_group_report_mv's row (see the
-- UPDATE below) -- so leaving it NULL costs nothing on screen.
INSERT INTO public.report_refresh_log (view_name, refreshed_at)
VALUES ('offer_report_offer_totals_mv', NULL)
ON CONFLICT (view_name) DO UPDATE SET refreshed_at = NULL;
--> statement-breakpoint
-- offer_group_report_mv's own report_refresh_log row (seeded by 0093, kept
-- current since by the twice-daily cron) still holds the timestamp of the
-- last cron run BEFORE this migration applied. The DROP + CREATE MATERIALIZED
-- VIEW above rebuilt it with fresh data at apply time, but left that row
-- untouched -- so without this, the page's "Data as of" banner (the only
-- place this row is read) would report the data as older than it actually
-- is, potentially old enough to trip the amber staleness warning for rows
-- that are seconds old.
UPDATE public.report_refresh_log SET refreshed_at = now()
WHERE view_name = 'offer_group_report_mv';
