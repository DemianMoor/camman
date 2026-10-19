-- 0214: lifecycle-cohort columns for the per-offer Group Report
-- (/offers/[id]/report, behind the "Show lifecycle detailed report" checkbox).
--
-- One row per (org, offer, group) with Sent 14d / Sent 90d / Fresh pool split
-- into three cohorts by the contact's CURRENT lifecycle status
-- (contacts.lifecycle_status, the projection of contact_engagement.status):
--   hw_*     = hot + warm
--   cold_*   = cold
--   freeze_* = freeze
-- `new` and `suppressed` contacts are in no cohort column; new contacts remain
-- in the overall Fresh pool on offer_group_report_mv (owner ruling, 2026-10-19).
--
-- CURRENT status, not status-at-send (owner ruling, 2026-10-19): the three
-- columns of a cohort then describe ONE population -- "of today's Hot/Warm,
-- how many messages has this offer sent them, and how many has it never
-- reached". stage_send_lifecycle (status at send) would put the Sent columns
-- and Fresh pool on different populations.
--
-- A NEW matview rather than columns on offer_group_report_mv: adding columns
-- means DROP + CREATE of that view AND audience_report_group_totals_mv (which
-- sums it), and 0126/0128 show that pair loses semantics on recreate. This view
-- depends on no other matview, so it refreshes LAST and its failure freezes only
-- the lifecycle columns.
--
-- SCOPE MIRRORS offer_group_report_mv PER COLUMN, so a cohort's figure is a
-- subset of the matching overall column (modulo status changes between the two
-- refreshes, which run seconds apart):
--   * Sent 14d/90d = MESSAGES (stage_sends rows, status 'sent'), the same unit
--     and scope as sent_7d/30d/90d: this offer's tracked campaigns, recipient a
--     member of a group the campaign targeted, campaign resolved via the STAGE.
--   * Fresh pool = the 0133 definition (eligible, not opted out, never exposed
--     to this offer per offer_exposures), split by status. Same
--     "sendable per group MINUS exposed per (offer, group)" shape and for the
--     same reason -- the direct anti-join measured 45.6s vs 9.4s.
-- Unit: Sent columns count messages, Fresh pool counts contacts (as on the
-- existing columns; owner chose messages for Sent, 2026-10-19).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE MATERIALIZED VIEW public.offer_group_lifecycle_mv AS
WITH sends AS (
  SELECT camp.org_id, camp.offer_id, ccg.contact_group_id AS group_id,
    COUNT(*) FILTER (WHERE ct.lifecycle_status IN ('hot', 'warm') AND ss.sent_at >= now() - interval '14 days')::bigint AS hw_sent_14d,
    COUNT(*) FILTER (WHERE ct.lifecycle_status IN ('hot', 'warm'))::bigint                                              AS hw_sent_90d,
    COUNT(*) FILTER (WHERE ct.lifecycle_status = 'cold' AND ss.sent_at >= now() - interval '14 days')::bigint            AS cold_sent_14d,
    COUNT(*) FILTER (WHERE ct.lifecycle_status = 'cold')::bigint                                                         AS cold_sent_90d,
    COUNT(*) FILTER (WHERE ct.lifecycle_status = 'freeze' AND ss.sent_at >= now() - interval '14 days')::bigint          AS freeze_sent_14d,
    COUNT(*) FILTER (WHERE ct.lifecycle_status = 'freeze')::bigint                                                       AS freeze_sent_90d
  FROM public.stage_sends ss
  JOIN public.campaign_stages cs ON cs.id = ss.stage_id
  JOIN public.offer_report_tracked_campaigns camp ON camp.id = cs.campaign_id
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = ss.contact_id
   AND ccg.contact_group_id = ANY(camp.gids)
   AND ccg.org_id = camp.org_id
  JOIN public.contacts ct ON ct.id = ss.contact_id AND ct.org_id = camp.org_id
  WHERE ss.status = 'sent'
    AND ss.sent_at >= now() - interval '90 days'
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
  COALESCE(s.hw_sent_90d, 0)::bigint     AS hw_sent_90d,
  (COALESCE(g.hw, 0) - COALESCE(x.hw, 0))::bigint         AS hw_fresh_pool,
  COALESCE(s.cold_sent_14d, 0)::bigint   AS cold_sent_14d,
  COALESCE(s.cold_sent_90d, 0)::bigint   AS cold_sent_90d,
  (COALESCE(g.cold, 0) - COALESCE(x.cold, 0))::bigint     AS cold_fresh_pool,
  COALESCE(s.freeze_sent_14d, 0)::bigint AS freeze_sent_14d,
  COALESCE(s.freeze_sent_90d, 0)::bigint AS freeze_sent_90d,
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
-- Seeded NULL per the 0093/0132 convention: NULL = "not yet refreshed by the
-- cron". The refresh loop only UPDATEs this row, so it must exist.
INSERT INTO public.report_refresh_log (view_name, refreshed_at)
VALUES ('offer_group_lifecycle_mv', NULL)
ON CONFLICT (view_name) DO NOTHING;
