-- 0183 report views read the conversion_events ledger (Phase 3).
--
-- Three objects carried their own copy of the per-recipient conversion columns:
--   offer_report_offer_totals_mv  attributable_revenue = SUM(ss.sale_revenue)
--                                 attributable_sales   = COUNT(ss.converted_at)
--   offer_group_report_mv         revenue / sales per cell, same two columns
--   audience_report_group_totals_mv  sums the cells above
--
-- stage_sends could hold ONE conversion per recipient (latest datetime wins), so
-- a second conversion was dropped (measured: 14 recipients, $715) and — once
-- registrations arrive — a $0 registration would overwrite a purchase and still
-- read as a sale. They now aggregate conversion_events (migration 0181) per
-- stage_send_id, with the shared definitions from lib/sale-attribution.ts copied
-- LITERALLY (a matview cannot import TypeScript):
--   purchase  event_type_id IN (SELECT id FROM event_types WHERE is_purchase)
--             AND status IN ('pending','approved')
--   revenue   event_type_id IN (SELECT id FROM event_types WHERE counts_revenue)
--             AND status = 'approved'
--   pending   the same, status = 'pending' -- a SEPARATE column, never summed
--             into revenue (user decision 3)
--
-- TWO guards keep these copies from drifting from the TypeScript:
--   scripts/verify-offer-group-attribution.ts criterion 7d — STRUCTURAL, runs
--     against any database (incl. prod): reads the shipped pg_get_viewdef and
--     asserts both matviews still reference conversion_events / is_purchase /
--     counts_revenue, and still carry the cv.org_id join predicate below.
--   scripts/test-report-matviews-from-ledger-db.ts "predicate parity" — SEMANTIC,
--     preview only: extracts the three FILTER predicates from THIS FILE and
--     evaluates them next to purchasedClause() / approvedRevenueClause() /
--     pendingRevenueClause() from lib/sale-attribution.ts over the same ledger
--     rows, asserting they agree row for row.
-- (Phase 3 Task 7's scripts/verify-conversion-reader-switch.ts will add the
-- live-data comparison on top; it does not exist yet, so it is not claimed here.)
--
-- MULTI-TENANCY (CLAUDE.md §3): `conv` carries org_id and BOTH joins below match
-- on it. The two go together — adding org_id to the CTE without the join
-- predicate fans a recipient out into one row per org that has a ledger row for
-- that stage_send_id, and adding it to the join without the CTE does not compile.
--
-- APPLY-TIME STATE — REWRITTEN 2026-09-21, AND IT NOW SAYS THE OPPOSITE OF WHAT
-- IT USED TO. The original block claimed the three matviews below are built from
-- an EMPTY ledger and therefore read $0 revenue / 0 sales to live users until
-- Phase 1's backfill runs. That was true when it was written and is FALSE NOW:
-- 0181 applied to production AHEAD of this file, and conversion_events is
-- backfilled and taking live rows. Measured read-only on prod 2026-09-21:
--     conversion_events            1,517 rows, 1,486 carrying a stage_send_id,
--                                  first 2026-09-18, latest 2026-09-21
--     attributable at CREATE time  $100,763.0000 approved revenue · 1,482 sales
--                                  (the same purchase/revenue predicates as the
--                                  matviews below, aggregated per stage_send_id)
-- `CREATE MATERIALIZED VIEW ... AS` still populates immediately — that part was
-- never in question — but what it populates FROM is now a live ledger. There is
-- no $0 window: the instant this migration commits, /offers/[id]/report and
-- /reports/audience read real revenue. `WITH NO DATA` is still not the
-- alternative (it makes them unreadable).
--
-- WHAT SURVIVES THE CORRECTION: apply -> refresh still matters, but for
-- FRESHNESS, not for correctness. CREATE ... AS populates from the ledger as it
-- stood at COMMIT, so conversions landing after that are invisible until the
-- next refreshOfferGroupReport(). The HARD PRECONDITION block of Task 8 in
-- docs/superpowers/plans/2026-09-17-conversion-events-phase3.md still governs
-- the order, but its backfill step is already done on prod, so the remaining
-- sequence is apply -> refresh, not apply -> backfill -> refresh.
--
-- offer_group_report_mv's report_refresh_log row is STILL not stamped now() at
-- the bottom of this file, where 0132:426 and 0133:226 both did — but the reason
-- has changed with the facts. It is NO LONGER "stamping now() would assert that
-- the $0 on screen is current data"; the data is current. It is that the stamp
-- means "the CRON last rebuilt this view", and the cron has not run since the
-- apply. Leaving the previous cron stamp therefore UNDERSTATES the data's
-- freshness rather than overstating it — the conservative direction — and the
-- first refreshOfferGroupReport() after the apply corrects it.
--
-- ⚠️ THIS CORRECTION CHANGES THE FILE'S SHA-256 AND 0183 IS ALREADY APPLIED ON
-- camman-v2, so scripts/verify-migration-integrity.ts will report a hash
-- mismatch for idx 183 THERE, and only there. Deliberate, and cheap for three
-- reasons, each checked rather than assumed: (1) drizzle WRITES the hash and
-- never compares it (drizzle-orm/pg-core/dialect.js:44-71 — the same fact the
-- JOURNAL TIMESTAMP note below rests on), so the edit cannot change what is
-- applied anywhere; (2) PRODUCTION has not applied 0183 yet — it applies this
-- file exactly once, at the Task 8 gate, and records the CORRECTED hash, so the
-- database that matters is clean; (3) camman-v2's record already fails to
-- reconcile with this journal — read back 2026-09-21, it carries the pre-amend
-- hash for 0184 and two entries whose `when` (1792108800000, 1792368000000) no
-- longer exists in meta/_journal.json at all. The journal `when` is NOT bumped
-- here: bumping it would re-apply this file on camman-v2, which is a real
-- change, where a stale hash on a disposable preview project is a diagnostic
-- line. See docs/07-conventions.md.
--
-- STRUCTURE IS OTHERWISE UNCHANGED, deliberately: every CTE, join path, dedupe
-- grain and comment below is reproduced from 0132 / 0133 / 0180. Only the
-- conversion sources change, plus the new pending column and the REVOKEs.
--
-- DEPENDENCY ORDER: audience_report_group_totals_mv reads offer_group_report_mv,
-- which (with offer_report_offer_totals_mv) reads offer_report_campaign_econ and
-- offer_report_tracked_campaigns. Drop the dependent first, create it last.
--
-- REFRESH: refreshOfferGroupReport() still refreshes summary -> group -> totals
-- -> audience totals, each CONCURRENTLY, which needs the unique indexes
-- recreated below. Cost: re-measured read-only on prod 2026-09-21, this time
-- UNSTUBBED (0181 has applied, so conversion_events is real), three runs of the
-- three SELECTs below under EXPLAIN (ANALYZE, BUFFERS):
--     offer_report_offer_totals_mv      35.7 / 36.5 / 35.6 s
--     offer_group_report_mv            112.1 / 111.2 / 114.8 s
--     audience_report_group_totals_mv    1.2 /  1.1 /  1.1 s   (measured
--         separately; pending_revenue stubbed to 0, since the INSTALLED
--         offer_group_report_mv it reads predates this file)
--     per-run total                    147.8 / 147.7 / 150.4 s
-- The 2026-09-18 stubbed figures (43.4 / 116.7 / 1.2) are superseded; the
-- caveats and the two earlier measurements are in
-- app/api/cron/refresh-offer-group-report/route.ts.
--
-- ⚠️ THIS FILE IS NOT WHAT MAKES THE REFRESH EXPENSIVE, and the number that
-- shows it is the INSTALLED definition's own SELECT: read back from
-- pg_get_viewdef on the same day, the PRE-0183 offer_group_report_mv SELECT
-- costs 109.6 / 111.8 / 113.2 s (avg 111.5) against this file's 112.7 avg. The
-- ledger CTE adds ~1.2 s to a ~112 s query — inside run-to-run variance. What
-- dominates is a sort that spills to disk: one node reports
-- `external merge  Sort Space Used: 170160 kB` at the cluster's work_mem of
-- 5120 kB, while every other sort in the plan is an in-memory quicksort of
-- <= 5 MB.
--
-- ⛔ AND THE CEILING IS NOT THE ROUTE'S maxDuration = 300. Prod's
-- statement_timeout is 120000 ms (source: configuration file,
-- /etc/postgresql-custom/platform-defaults.conf:6 — a Supabase cluster default
-- on every connection; pg_db_role_setting has no entry for the postgres role),
-- and refreshOfferGroupReport() never raises it. The last real cron run
-- (2026-09-21 05:01-05:03 UTC, PRE-0183) refreshed offer_group_report_mv
-- CONCURRENTLY in 107.5 s — read back as the delta between consecutive
-- report_refresh_log stamps. That is 12.5 s of headroom against the 120 s wall,
-- BEFORE this file, and this file spends about 1 s of it. The wall is a
-- pre-existing problem that 0183 neither causes nor fixes; see
-- docs/04-features/offer-group-report.md.
--
-- SALES IS NOW PER-EVENT, NOT PER-RECIPIENT. `sales` / `attributable_sales`
-- count ledger ROWS, so a recipient with two purchases is two sales and a cell's
-- Sales can legitimately EXCEED its Sends. "Sales" no longer means "buyers".
-- Nothing asserts sales <= sends, and the offer report's coverage wording
-- already handles >100%.
--
-- PENDING IS SURFACED ON THE OFFER REPORT ONLY. offer_group_report_mv and
-- audience_report_group_totals_mv both carry `pending_revenue`, but
-- lib/reporting/audience-report.ts does not select it, so the Audience Stats
-- screen gains no Pending column. Deliberate scope, not an oversight: the
-- column exists so the two matviews stay additive (audience totals SUM the
-- cells) and so adding the screen column later is a reader change only.
--
-- JOURNAL TIMESTAMP BUMPED ONCE, BEFORE RELEASE (1792195200000 -> 1792281600000,
-- 2026-09-18). NOT drift. Drizzle selects pending migrations by the journal's
-- `when`, never by the file hash (drizzle-orm/pg-core/dialect.js:44-71 — the
-- hash is written and never compared), so amending this already-applied-on-
-- preview file would otherwise have left camman-v2 on the pre-org_id
-- definition forever. Legitimate only because 0183 is unreleased (prod is at
-- 0180 and applies this file exactly once, at the Task 8 gate) and because
-- every statement below is re-runnable. See docs/07-conventions.md.
--
-- Recon: docs/superpowers/specs/2026-09-17-multi-event-conversions-recon.md
-- Plan:  docs/superpowers/plans/2026-09-17-conversion-events-phase3.md

-- Drizzle applies every pending migration in ONE transaction, so a combined
-- 0181-0183 apply already runs under 0181's lock_timeout. This re-asserts it for
-- a SOLO apply or roll-forward of 0183 alone, which takes ACCESS EXCLUSIVE on
-- three matviews and would otherwise wait behind a report read with no bound.
-- A blocked lock fails the migration instead of queueing everything behind it;
-- just retry. SET LOCAL is scoped to the apply transaction either way, so on a
-- combined apply this is a harmless re-set of the same value.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DROP MATERIALIZED VIEW IF EXISTS public.audience_report_group_totals_mv;
--> statement-breakpoint
DROP MATERIALIZED VIEW IF EXISTS public.offer_group_report_mv;
--> statement-breakpoint
DROP MATERIALIZED VIEW IF EXISTS public.offer_report_offer_totals_mv;
--> statement-breakpoint
-- Re-asserting what 0113 set and 0126/0128 each silently dropped by
-- DROP VIEW + CREATE VIEW without carrying the option forward. Neither view is
-- otherwise touched here; these two ALTERs exist so the property is asserted on
-- every migration that recreates anything in this family
-- (scripts/verify-migration-integrity.ts checks both).
ALTER VIEW public.offer_report_tracked_campaigns SET (security_invoker = true);
--> statement-breakpoint
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
-- Per-recipient conversions from the ledger, keyed on the send row and
-- aggregated BEFORE any membership test: joining conversion_events straight into
-- `attributable` would multiply `n` (the send count) by the number of
-- conversions on a row.
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
  GROUP BY ce.org_id, ce.stage_send_id
),
-- DISTINCT sends, not the sum of the group cells: that sum is non-additive by
-- design and using it here would reintroduce the defect 0132 removed.
-- Membership is tested as EXISTS rather than a JOIN so a recipient who belongs
-- to several of the campaign's targeted groups still contributes exactly one
-- row here -- joining contact_contact_groups directly (as `attr` does for the
-- group cells) would fan revenue/sales out across each matching group,
-- reintroducing the same defect at the offer grain instead of the group grain.
attributable AS (
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
    -- org_id on the join, matching the six other joins in this file: the
    -- project's #1 rule is that every read of domain data is org-scoped, and
    -- `conv` is grouped by (org_id, stage_send_id) so this predicate is what
    -- keeps a foreign-org ledger row off this org's revenue. Changes no rows
    -- today (stage_send_id is a UUID primary key).
    LEFT JOIN conv cv ON cv.stage_send_id = ss.id AND cv.org_id = camp.org_id
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
  COALESCE(a.pending_revenue, 0)::numeric(14,4) AS attributable_pending_revenue,
  (b.sends - COALESCE(a.n, 0))::bigint          AS unattributed_sends
FROM base b
LEFT JOIN attributable  a  ON a.org_id  = b.org_id AND a.offer_id  = b.offer_id
LEFT JOIN offer_tracked ot ON ot.org_id = b.org_id AND ot.offer_id = b.offer_id
LEFT JOIN offer_manual  om ON om.org_id = b.org_id AND om.offer_id = b.offer_id;
--> statement-breakpoint
CREATE UNIQUE INDEX offer_report_offer_totals_mv_key_uniq
  ON public.offer_report_offer_totals_mv (org_id, offer_id);
--> statement-breakpoint
-- Read only over DATABASE_URL (lib/reporting/offer-group-report.ts), never
-- through PostgREST. 0132 left it anon-readable; 0180 established the REVOKE.
REVOKE ALL ON public.offer_report_offer_totals_mv FROM anon, authenticated;
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
-- Per-recipient conversions from the ledger, aggregated BEFORE the group
-- fan-out for the same reason as in the matview above.
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
  GROUP BY ce.org_id, ce.stage_send_id
),
-- ONE pass over the stage_sends x contact_contact_groups join: economics AND
-- list pressure. The marginal COST is ~zero because that join already ran for
-- the list-pressure columns alone -- but the POPULATION is not unchanged versus
-- 0128: sent_7d/30d/90d share the offer_report_tracked_campaigns /
-- ANY(camp.gids) scope with the economics columns, so they are a strict SUBSET
-- of their 0128 values. Intentional and approved -- see 0133's header.
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
  -- org_id on the join: same reasoning as `attributable` above and the six
  -- other org-guarded joins in this file.
  LEFT JOIN conv cv ON cv.stage_send_id = ss.id AND cv.org_id = camp.org_id
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
  a.sends, a.revenue, a.pending_revenue, a.sales,
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
REVOKE ALL ON public.offer_group_report_mv FROM anon, authenticated;
--> statement-breakpoint
CREATE MATERIALIZED VIEW public.audience_report_group_totals_mv AS
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
  s.sends, s.revenue, s.pending_revenue, s.sales,
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
--> statement-breakpoint
-- The sibling of the statement above, reproduced from 0132:414-416 for the
-- other matview this migration drops and recreates. Its stored timestamp is the
-- last CRON run's, which now describes a view definition that no longer exists;
-- NULL restores the family's convention ("not yet refreshed by the cron"). Like
-- the audience row, this one is never read on screen — getOfferGroupReport()
-- takes "Data as of" from offer_group_report_mv's row only.
UPDATE public.report_refresh_log SET refreshed_at = NULL
WHERE view_name = 'offer_report_offer_totals_mv';
--> statement-breakpoint
-- Backfill: the exact seed 0181 ran, for any org created since (0181 only ran
-- once, at that moment). ON CONFLICT makes this a no-op for every org that
-- already has its rows — ~all of them, at this point. The trigger fix below
-- closes the gap going forward.
INSERT INTO public.event_types
  (org_id, key, label, display_order, is_purchase, counts_revenue, is_retarget_signal)
SELECT o.id, v.key, v.label, v.display_order, v.is_purchase, v.counts_revenue, v.is_retarget_signal
FROM public.organizations o
CROSS JOIN (VALUES
  ('purchase', 'Purchase', 10, true, true, false),
  ('registration', 'Registration', 20, false, false, true)
) AS v(key, label, display_order, is_purchase, counts_revenue, is_retarget_signal)
ON CONFLICT (org_id, key) DO NOTHING;
--> statement-breakpoint
-- Forward fix for the gap the backfill above just closed: handle_new_user()
-- is the ONLY thing that creates an organization (self-signup — an invited
-- user returns early above and joins an EXISTING org, which already has its
-- rows), so it is the only place that can seed event_types for a NEW one.
-- CREATE OR REPLACE keeps every existing behaviour (0177's invite
-- short-circuit, the org + org_members inserts) byte-for-byte and appends the
-- two event-type inserts after org_members, inside the SAME trigger
-- transaction: if that insert ever failed it would fail the signup, which is
-- correct — a signup that can't get its event-type registry should not
-- silently succeed missing it.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_org_id uuid;
  user_display_name text;
BEGIN
  -- Invited users join the inviting org via app/auth/callback/route.ts.
  -- Creating an org here would pre-empt that and strand them in an empty one.
  IF EXISTS (
    SELECT 1
    FROM public.invites i
    WHERE lower(i.email) = lower(NEW.email)
      AND i.accepted_at IS NULL
      AND i.expires_at > now()
  ) THEN
    RETURN NEW;
  END IF;

  user_display_name := COALESCE(
    NEW.raw_user_meta_data->>'display_name',
    split_part(NEW.email, '@', 1)
  );

  INSERT INTO public.organizations (name)
  VALUES (user_display_name || '''s Organization')
  RETURNING id INTO new_org_id;

  INSERT INTO public.org_members (user_id, org_id, role)
  VALUES (NEW.id, new_org_id, 'owner');

  -- 0183: seed this org's event-type registry the same way 0181 seeded every
  -- org that existed at that migration. ON CONFLICT DO NOTHING is defensive
  -- only — new_org_id was just minted above and cannot already have rows.
  INSERT INTO public.event_types
    (org_id, key, label, display_order, is_purchase, counts_revenue, is_retarget_signal)
  VALUES
    (new_org_id, 'purchase', 'Purchase', 10, true, true, false),
    (new_org_id, 'registration', 'Registration', 20, false, false, true)
  ON CONFLICT (org_id, key) DO NOTHING;

  RETURN NEW;
END;
$$;
