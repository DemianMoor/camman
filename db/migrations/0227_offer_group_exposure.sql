-- 0227: Offer Group report — offer exposure per lifecycle cohort
-- (owner, 2026-10-27; ClickUp 1amdve28n15, follow-up to 0226 / 1amdve284ue).
--
-- New matview offer_group_exposure_mv, one row per (org, offer, group) — the
-- same (offer, group) universe as offer_group_lifecycle_v2_mv — with four
-- columns per cohort (Hot, Warm, Cold, Freeze = the contact's CURRENT
-- lifecycle_status), counting SENDABLE contacts (0133 definition: eligible,
-- not opted out) in the group:
--
--   <cohort>_x0        never sent this offer       (no contact_offer_campaigns row)
--   <cohort>_x1        sent it in exactly 1 campaign
--   <cohort>_x2plus    sent it in 2+ campaigns
--   <cohort>_eligible  "Eligible now" for a new campaign of this offer at the
--                      defaults: 0x or 1x (limit 2 — 2+ blocks), last send of
--                      this offer at least 14 days ago (cooldown 14: `<=` here
--                      is the exact complement of the send path's blocking
--                      `last_sent_at > now() - 14 days`, lib/sends/eligibility.ts),
--                      not a buyer of the offer (purchasedOfferContacts), and
--                      for Freeze not inside the contact's rest period
--                      (freeze_not_due).
--
-- x0 + x1 + x2plus = the cohort's sendable contacts in the group, for every
-- offer of that group (the verify script checks it).
--
-- ⚠️ EXPOSURE COMES FROM contact_offer_campaigns FOR ALL FOUR BUCKETS (owner,
-- 2026-10-27), 0x included. The old "fresh pool" (0133/0226) reads
-- offer_exposures instead, so the screen's 0x relabels that column with a
-- slightly different source; the gap was measured on the card. One row per
-- (contact, offer, campaign) = one exposure — campaigns, not messages, the
-- same unit the offer limit counts.
--
-- ⚠️ ADDITIVE, WITH NO DATA — the 0226 pattern. Building it reads
-- contact_offer_campaigns (~1 GB) and does not fit prod's 120 s server-wide
-- statement_timeout inside db:migrate, so this only DEFINES the view. The
-- first fill is attended: scripts/fill-offer-group-exposure.ts (plain REFRESH
-- on the report's own session, 180 s / 384 MB), then
-- scripts/verify-offer-group-exposure.ts. The code that reads and refreshes
-- it ships after the fill. Twice-daily refresh: /api/cron/refresh-offer-group-
-- lifecycle (05:30 / 20:30 UTC), its own cron run, with offer_group_lifecycle_v2_mv.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE MATERIALIZED VIEW IF NOT EXISTS public.offer_group_exposure_mv AS
WITH sendable AS (
  SELECT ccg.contact_group_id AS group_id, ct.org_id, ct.id AS contact_id,
         ct.lifecycle_status AS cohort,
         (ct.lifecycle_status = 'freeze' AND EXISTS (
            SELECT 1 FROM public.contact_engagement e
            WHERE e.contact_id = ct.id AND e.org_id = ct.org_id AND e.status = 'freeze'
              AND e.last_sent_at > now() - make_interval(days => e.freeze_cadence_days)
         )) AS resting
  FROM public.contacts ct
  JOIN public.contact_contact_groups ccg
    ON ccg.contact_id = ct.id AND ccg.org_id = ct.org_id
  WHERE ct.messaging_status = 'eligible'
    AND ct.lifecycle_status IN ('hot', 'warm', 'cold', 'freeze')
    AND NOT EXISTS (SELECT 1 FROM public.opt_outs o WHERE o.contact_id = ct.id AND o.org_id = ct.org_id)
),
pairs AS (
  SELECT DISTINCT camp.org_id, camp.offer_id, g.group_id
  FROM public.offer_report_tracked_campaigns camp
  CROSS JOIN LATERAL unnest(camp.gids) AS g(group_id)
),
exposure AS (
  SELECT coc.org_id, coc.contact_id, coc.offer_id,
         count(*)::int AS n, max(coc.last_sent_at) AS last_sent_at
  FROM public.contact_offer_campaigns coc
  WHERE coc.offer_id IN (SELECT DISTINCT offer_id FROM pairs)
  GROUP BY 1, 2, 3
),
buyers AS (
  SELECT DISTINCT ce.org_id, ce.contact_id, ca.offer_id
  FROM public.conversion_events ce
  JOIN public.campaigns ca ON ca.id = ce.campaign_id
  JOIN public.event_types et ON et.id = ce.event_type_id AND et.is_purchase
  WHERE ce.contact_id IS NOT NULL AND ce.status IN ('pending', 'approved')
),
per_group AS (
  SELECT org_id, group_id, cohort, count(*)::bigint AS sendable,
         count(*) FILTER (WHERE NOT resting)::bigint AS not_resting
  FROM sendable GROUP BY 1, 2, 3
),
exposed AS (
  SELECT s.org_id, x.offer_id, s.group_id, s.cohort,
         count(*) FILTER (WHERE x.n = 1)::bigint AS x1,
         count(*) FILTER (WHERE x.n >= 2)::bigint AS x2plus,
         count(*) FILTER (WHERE x.n = 1 AND x.last_sent_at <= now() - interval '14 days'
                            AND b.contact_id IS NULL AND NOT s.resting)::bigint AS elig_from_1x,
         count(*) FILTER (WHERE NOT s.resting)::bigint AS exposed_not_resting
  FROM sendable s
  JOIN exposure x ON x.contact_id = s.contact_id AND x.org_id = s.org_id
  LEFT JOIN buyers b ON b.contact_id = s.contact_id AND b.offer_id = x.offer_id AND b.org_id = s.org_id
  GROUP BY 1, 2, 3, 4
),
buyers_unexposed AS (
  SELECT s.org_id, b.offer_id, s.group_id, s.cohort, count(*)::bigint AS n
  FROM buyers b
  JOIN sendable s ON s.contact_id = b.contact_id AND s.org_id = b.org_id AND NOT s.resting
  WHERE NOT EXISTS (SELECT 1 FROM exposure x WHERE x.contact_id = b.contact_id AND x.offer_id = b.offer_id)
  GROUP BY 1, 2, 3, 4
),
cells AS (
  SELECT p.org_id, p.offer_id, p.group_id, c.cohort,
         COALESCE(g.sendable, 0) - COALESCE(e.x1, 0) - COALESCE(e.x2plus, 0)  AS x0,
         COALESCE(e.x1, 0)                                                    AS x1,
         COALESCE(e.x2plus, 0)                                                AS x2plus,
         (COALESCE(g.not_resting, 0) - COALESCE(e.exposed_not_resting, 0) - COALESCE(bu.n, 0))
           + COALESCE(e.elig_from_1x, 0)                                      AS eligible
  FROM pairs p
  CROSS JOIN (VALUES ('hot'), ('warm'), ('cold'), ('freeze')) AS c(cohort)
  LEFT JOIN per_group g ON g.org_id = p.org_id AND g.group_id = p.group_id AND g.cohort = c.cohort
  LEFT JOIN exposed e ON e.org_id = p.org_id AND e.offer_id = p.offer_id AND e.group_id = p.group_id AND e.cohort = c.cohort
  LEFT JOIN buyers_unexposed bu ON bu.org_id = p.org_id AND bu.offer_id = p.offer_id AND bu.group_id = p.group_id AND bu.cohort = c.cohort
)
SELECT org_id, offer_id, group_id,
  max(x0)       FILTER (WHERE cohort = 'hot')::bigint    AS hot_x0,
  max(x1)       FILTER (WHERE cohort = 'hot')::bigint    AS hot_x1,
  max(x2plus)   FILTER (WHERE cohort = 'hot')::bigint    AS hot_x2plus,
  max(eligible) FILTER (WHERE cohort = 'hot')::bigint    AS hot_eligible,
  max(x0)       FILTER (WHERE cohort = 'warm')::bigint   AS warm_x0,
  max(x1)       FILTER (WHERE cohort = 'warm')::bigint   AS warm_x1,
  max(x2plus)   FILTER (WHERE cohort = 'warm')::bigint   AS warm_x2plus,
  max(eligible) FILTER (WHERE cohort = 'warm')::bigint   AS warm_eligible,
  max(x0)       FILTER (WHERE cohort = 'cold')::bigint   AS cold_x0,
  max(x1)       FILTER (WHERE cohort = 'cold')::bigint   AS cold_x1,
  max(x2plus)   FILTER (WHERE cohort = 'cold')::bigint   AS cold_x2plus,
  max(eligible) FILTER (WHERE cohort = 'cold')::bigint   AS cold_eligible,
  max(x0)       FILTER (WHERE cohort = 'freeze')::bigint AS freeze_x0,
  max(x1)       FILTER (WHERE cohort = 'freeze')::bigint AS freeze_x1,
  max(x2plus)   FILTER (WHERE cohort = 'freeze')::bigint AS freeze_x2plus,
  max(eligible) FILTER (WHERE cohort = 'freeze')::bigint AS freeze_eligible
FROM cells
GROUP BY org_id, offer_id, group_id
WITH NO DATA;
--> statement-breakpoint
-- REFRESH ... CONCURRENTLY (the twice-daily cron) requires a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS offer_group_exposure_mv_key_uniq
  ON public.offer_group_exposure_mv (org_id, offer_id, group_id);
--> statement-breakpoint
-- Read only over DATABASE_URL (lib/reporting/offer-group-report.ts), never
-- through PostgREST -- same REVOKE as the other report matviews (0180, 0226).
REVOKE ALL ON public.offer_group_exposure_mv FROM anon, authenticated;
--> statement-breakpoint
-- Seeded NULL per the 0093/0132 convention: NULL = "not yet refreshed". The
-- refresh loop only UPDATEs this row, so it must exist.
INSERT INTO public.report_refresh_log (view_name, refreshed_at)
VALUES ('offer_group_exposure_mv', NULL)
ON CONFLICT (view_name) DO NOTHING;
