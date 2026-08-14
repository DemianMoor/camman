-- Migration 0133: restore the Fresh pool column's meaning.
--
-- THE BUG, and it is a regression. Migration 0093 defined Fresh pool exactly as
-- the feature doc still described it: contacts in the group with no send for
-- THIS offer, AND not present in opt_outs --
--
--   LEFT JOIN sent_offer_contacts s ON s.offer_id = e.offer_id AND ...
--   LEFT JOIN optout_contacts     o ON o.contact_id = gc.contact_id
--   WHERE s.contact_id IS NULL AND o.contact_id IS NULL
--
-- Migration 0126 replaced that with "no 'sent' row in the last 90 days, across
-- ALL offers, no opt-out filter" -- a silent semantic change unrelated to that
-- migration's stated purpose. 0128 copied it verbatim; 0132 copied it forward
-- again, and 0132's documentation task then rewrote the feature doc to match
-- the broken SQL rather than recognising the SQL had drifted from the spec.
-- Three migrations carried it; the doc was right the whole time.
--
-- WHY IT MATTERS. Two errors pointing in opposite directions:
--
--   1. Opt-outs are counted as available, and the column ACCUMULATES them. A
--      contact opts out, is correctly never messaged again, their last send
--      ages past 90 days, and they re-enter the "fresh" pool permanently.
--      Measured on group 6 (Nerve Pain): 3,051 reported, of which 3,034 were
--      opted out. 17 were actually sendable. Campaign creation always excludes
--      opt-outs, so the operator saw a pool of 3,051 and an audience of ~0.
--
--   2. Contacts are excluded for having received a DIFFERENT offer recently,
--      even though they have never seen this one.
--
-- Net effect: the column does not merely overstate, it INVERTS the ranking it
-- exists to support. Measured against offer 62 --
--
--     group             reported    correct
--     AstroEnergy         21,340     90,872   (understated 4.3x)
--     Manifestation       14,484     54,685   (understated 3.8x)
--     Memory              21,359        706   (overstated  30x)
--     Weight Loss         23,606      9,667
--     Nerve Pain           3,051      4,010
--
-- Sorting by Fresh pool sent the operator at Memory (706 left) while
-- AstroEnergy sat on ~70,000 unused contacts it did not report.
--
-- THE FIX. sendable = messaging_status 'eligible' (the same landline-free gate
-- lib/audience-snapshot.ts applies) AND not in opt_outs. Then anti-join
-- offer_exposures per offer -- exact: 506,952 rows for offer 62, equal to the
-- distinct contacts ever sent one of its campaigns. "Ever exposed", not a
-- window, matching 0093 and the campaign form's exclude_prior_offer_contacts.
--
-- Only offer_group_report_mv changes. offer_report_campaign_econ,
-- offer_report_tracked_campaigns, offer_report_offer_totals_mv and
-- offer_report_org_summary_mv are untouched, so this is NOT destructive against
-- the deployed reader: the column list is identical and only fresh_pool's
-- values change. It can be applied before or after this branch deploys.
--
-- security_invoker: no view is dropped or recreated here, so nothing to
-- re-assert (see 07-conventions "Reporting views"). Verified by
-- scripts/verify-migration-integrity.ts, which asserts it on both views.
DROP MATERIALIZED VIEW IF EXISTS public.offer_group_report_mv;
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
-- FRESH POOL -- restored to migration 0093's semantics. See the header.
--
-- `sendable` is the group's contactable membership: eligible (landline-free,
-- the same `messaging_status = 'eligible'` gate lib/audience-snapshot.ts uses)
-- and NOT opted out. Opt-outs are the defect this migration exists to fix:
-- 0126 dropped the opt-out filter, so a contact who opted out and was then
-- correctly never messaged again aged past the 90-day window and re-entered
-- the "fresh" pool. The column therefore ACCUMULATED opt-outs over time.
--
-- Exposure is anti-joined per OFFER via offer_exposures, which is exact
-- (506,952 rows for offer 62 == distinct contacts ever sent a campaign of it).
-- Computed as `sendable per group MINUS exposed per (offer, group)` rather
-- than a direct per-offer anti-join over every contact: the direct form
-- materialises an offers x contacts product (6.8M rows, spills to temp) and
-- measured 45.6s, versus 9.4s for this subtraction form. Both return the same
-- numbers; only the plan differs. Do not "simplify" this back.
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
  -- Offer list comes from `attr` (this same query), NOT from
  -- offer_report_offer_totals_mv. Reading that matview here would create a
  -- matview-to-matview data dependency, which argues for refreshing totals
  -- FIRST -- contradicting the deploy-safety reason 0132 moved it LAST (a
  -- code-before-migration deploy must not kill the other two refreshes).
  -- `attr` is exactly the set of (org, offer) that HAS group rows, so this is
  -- also strictly more correct than the totals list, which includes offers
  -- with no tracked campaigns and therefore no rows to attach fresh_pool to.
  FROM (SELECT DISTINCT org_id, offer_id FROM attr) o
  JOIN sendable_per_group g ON g.org_id = o.org_id
  LEFT JOIN exposed_per_offer_group x
    ON x.org_id = o.org_id AND x.offer_id = o.offer_id AND x.group_id = g.group_id
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
LEFT JOIN fresh f ON f.org_id = a.org_id AND f.offer_id = a.offer_id AND f.group_id = a.group_id;
--> statement-breakpoint
CREATE UNIQUE INDEX offer_group_report_mv_key_uniq
  ON public.offer_group_report_mv (org_id, offer_id, group_id);
--> statement-breakpoint
-- The DROP + CREATE above rebuilt this matview with data current as of apply
-- time, but report_refresh_log still holds the previous cron run's timestamp.
-- Without this the page's "Data as of" banner reports seconds-old data as
-- hours old, potentially tripping the amber staleness warning. Same reasoning
-- as the equivalent statement in 0132.
UPDATE public.report_refresh_log SET refreshed_at = now()
WHERE view_name = 'offer_group_report_mv';
