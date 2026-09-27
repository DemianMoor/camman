import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { HUMAN_CLICK } from "@/lib/reporting/counted-clickers";
import { purchasedClause } from "@/lib/sale-attribution";

// ── THE LIFECYCLE COHORT REPORT (PR 5) ──────────────────────────────────────
//
// Per-recipient metrics grouped by the status stamped AT SEND, dated by send
// date in ET.
//
// ⚠️ COHORT COMES FROM THE STAMP, never from contact_engagement.status. The
// stamp is what the contact was when the message went out; the live column is
// what they are now. Reading the live one would move contacts between cohorts
// retroactively and make last week's number change every time you looked at
// it. Measured on stage 4791 nineteen hours after its send: stamped hot 1,306
// / warm 1,526, live hot 1,315 / warm 1,517.
//
// ⚠️ CTR USES RAW HUMAN_CLICK, not counted_clickers (owner, 2026-09-27). That
// is the source the engagement job evaluates against, so a cohort's CTR and
// the status that DEFINES that cohort are computed from the same clicks.
// Overview uses counted_clickers and the two disagree — 125 vs 112 on stage
// 4791 at 19h, because the scored table lags. The page footer says so.
//
// ⚠️ SALES/REVENUE ARE LEDGER-PRIMARY. stage_sends.sale_* is a fallback ONLY
// for sends with no ledger event (4 rows in 60 days). Those columns are
// documented as a write path kept for parity, with every app-side reader
// removed in Phase 3 Task 4 — giving them a new PRIMARY reader would block the
// card that drops them, for 4 rows. Revenue where both exist is the LEDGER's
// approved-only sum.
//
// ⚠️ COST IS THE STAGE COST MODEL AT SEND GRAIN: coalesce(the send's own
// cost_per_sms, the stage's implied rate) × (1 + opted out). An opt-out reply is
// billed like a send, so a cohort with more opt-outs costs more per send — that
// is the point, not a bug, and the footer says cost includes opt-out cost.
//
// ⚠️ IT COVERS ONLY STAGES WITH stage_sends ROWS. Manual/CSV stages carry their
// tally in campaign_stages.sms_count and have no per-recipient rows, so they
// contribute nothing here — which is one of the reasons this tab's totals do not
// foot with Overview's, and the page says so.

export const LIFECYCLE_COHORTS = [
  "new",
  "cold",
  "hot",
  "warm",
  "freeze",
  "suppressed",
] as const;

export type LifecycleCohort = (typeof LIFECYCLE_COHORTS)[number];

/** Rollups shown beneath the six, then the total, then the unstamped remainder. */
export type LifecycleRow =
  | LifecycleCohort
  | "clickers"
  | "non_clickers"
  | "total"
  | "unclassified";

export interface LifecycleMetrics {
  row: LifecycleRow;
  sends: number;
  clickers: number;
  ctr: number | null;
  sales: number;
  cr: number | null;
  revenue: string;
  opt_outs: number;
  opt_out_rate: number | null;
  cost: string;
  /** true when ANY send in this row was reconstructed rather than stamped live. */
  reconstructed: boolean;
}

export interface LifecycleReport {
  rows: LifecycleMetrics[];
  /** The period contains at least one reconstructed row — the page marks it. */
  has_reconstructed: boolean;
  from: string;
  to: string;
}

/**
 * Cohort metrics for an ET date range.
 *
 * `from`/`to` are ET calendar dates (inclusive), matching Overview's controls.
 */
export async function getLifecycleReport(opts: {
  orgId: string;
  from: string;
  to: string;
}): Promise<LifecycleReport> {
  const rows = (await db.execute(
    lifecycleReportSql(opts),
  )) as unknown as LifecycleReportRow[];
  return foldLifecycleRows(rows, opts.from, opts.to);
}

interface LifecycleReportRow {
  row: string;
  sends: number;
  clickers: number;
  sales: number;
  revenue: string;
  opt_outs: number;
  cost: string;
  reconstructed: boolean;
}

/**
 * The report query, exported so a measurement can EXPLAIN the REAL statement.
 * A diagnostic that re-types the query measures its own copy.
 *
 * ⚠️ ONE STATEMENT, NOT A TEMP TABLE — and the reason is what the measurements
 * could NOT show. The audience snapshot's fix (CLAUDE.md §10b) was tried here
 * first, on the theory that the window CTE's row estimate was collapsing the
 * plan. It did not reproduce: the same five-day window ran 51.5s as a CTE and
 * 53.6s materialized and ANALYZEd.
 *
 * Nor could the two be separated afterwards. Identical code on a 7-day window
 * measured 20.8s, 21.8s and 25.5s across runs — the spread between REPEATS is
 * as large as the gap between the variants, so any ranking read off single runs
 * would be noise. So this keeps the simpler shape: one statement, no
 * transaction, no temp table. What DID move the number, by factors rather than
 * by percentages, is the two shapes below.
 */
export function lifecycleReportSql(opts: {
  orgId: string;
  from: string;
  to: string;
}): SQL {
  const { orgId, from, to } = opts;
  const org = sql`${orgId}::uuid`;
  return sql`
    WITH lc_sent AS (
      SELECT ss.id, ss.contact_id, ss.stage_id, ss.cost_per_sms,
             ss.sale_status, l.status AS cohort, l.reconstructed
      FROM stage_sends ss
      LEFT JOIN stage_send_lifecycle l
             ON l.stage_send_id = ss.id AND l.org_id = ${org}
      WHERE ss.org_id = ${org} AND ss.status = 'sent'
        -- ⚠️ A HALF-OPEN RANGE ON RAW sent_at, NOT
        -- (sent_at AT TIME ZONE 'America/New_York')::date BETWEEN … . The
        -- expression form wraps the indexed column, so it cannot use
        -- stage_sends_org_sent_at_idx and seq-scans the whole table: measured at
        -- 15.2s for a ONE-DAY window that returned zero rows. The bounds below
        -- are the same ET days, expressed so the index can answer them.
        AND ss.sent_at >= (${from}::date AT TIME ZONE 'America/New_York')
        AND ss.sent_at < ((${to}::date + 1) AT TIME ZONE 'America/New_York')
    ),
    -- ⚠️ ONLY THE STAGES THAT NEED A RATE. The stage rate is a FALLBACK, read
    -- solely for sends whose own cost_per_sms is NULL — the send pipeline
    -- snapshots it per row at materialization, so most sends carry their own.
    -- Counting every stage in the window cost 7.4s of a 42.4s five-day window
    -- (159 per-stage index scans at ~46ms each, random I/O) to compute rates
    -- that nothing then read.
    win_stages AS (
      SELECT DISTINCT stage_id FROM lc_sent WHERE cost_per_sms IS NULL
    ),
    -- The fallback per-send rate for a send whose own cost_per_sms is NULL:
    -- the stage's total_cost divided by the SAME denominator that produced it
    -- (lib/stages/total-cost.ts), so apportioning it back across the stage's
    -- sends reproduces total_cost rather than a number near it.
    --
    -- ⚠️ greatest(sms_count, sent rows) is not defensive: an API stage
    -- materializes one stage_sends row per recipient and leaves sms_count at 0,
    -- while a manual stage carries the operator's tally in sms_count and has no
    -- stage_sends rows at all. Dividing by sms_count alone would divide by zero
    -- for every stage this report can see. The whole-stage count is deliberate —
    -- total_cost covers the whole stage, so the rate must too, even when the
    -- report's window holds only part of it.
    --
    -- ⚠️ GROUPED, NOT CORRELATED. As a scalar subquery inside the LATERAL, the
    -- count was expanded TWICE per stage (the CASE references denom twice), so
    -- every send of every stage in the window was counted twice over — the
    -- planner priced that nested loop at 7.9M and it dominated wider windows.
    -- The count is over the WHOLE stage on purpose: total_cost covers the whole
    -- stage, so the rate it implies must too, even when the window holds part.
    -- ⚠️ ONE COUNT PER STAGE, DRIVEN FROM THE STAGE LIST. The same count written
    -- as GROUP BY over stage_sends filtered by org_id + status + stage_id IN (…)
    -- leads with org_id and costs 14.5s against 3.9s on the same 2-day window:
    -- the planner picks the org index and filters millions of rows instead of
    -- descending stage_sends_stage_id_idx ~40 times.
    stage_sent_counts AS (
      SELECT w.stage_id, c.n
      FROM win_stages w
      CROSS JOIN LATERAL (
        SELECT count(*)::bigint AS n
        FROM stage_sends x
        WHERE x.stage_id = w.stage_id AND x.status = 'sent'
          AND x.org_id = ${org}
      ) c
    ),
    stage_rate AS (
      SELECT cs.id AS stage_id,
             CASE WHEN d.denom > 0 THEN cs.total_cost / d.denom ELSE 0 END AS rate
      FROM campaign_stages cs
      LEFT JOIN stage_sent_counts sc ON sc.stage_id = cs.id
      CROSS JOIN LATERAL (
        SELECT greatest(cs.sms_count, coalesce(sc.n, 0)) + cs.opt_out_count
                 AS denom
      ) d
      WHERE cs.org_id = ${org}
        AND cs.id IN (SELECT stage_id FROM win_stages)
    ),
    -- Raw human clicks at (stage, contact) — the SAME grain counted_clickers
    -- keys on, so a cohort's CTR here and Overview's differ only in the source
    -- of the clicks, never in what a "clicker" means.
    --
    -- ⚠️ BOTH JOIN COLUMNS ARE LOAD-BEARING. On contact_id alone this counts
    -- every link that contact ever clicked, org-wide, across every campaign —
    -- so Hot contacts (who click a lot) would import their whole click history
    -- into whatever cohort they sit in today, and the cohort CTR would measure
    -- the contacts rather than the send.
    --
    -- No clicked_at >= sent_at guard: the link is minted per (stage, contact),
    -- so a click on it belongs to this send by construction, while sent_at is
    -- not reliably before the click — "Mark as sent" stamps the scheduler's
    -- fire-lock time, which can post-date the real send.
    -- Every stage in the window. Distinct from win_stages above, which is
    -- narrowed to the stages that need a cost rate.
    all_win_stages AS (
      SELECT DISTINCT stage_id FROM lc_sent
    ),
    -- ⚠️ DRIVEN FROM THE WINDOW'S LINKS, BY STAGE. Two shapes were measured on
    -- the same five-day window and both lose to this one:
    --
    --   join sent → links → clicks        34.3s of 42.4s
    --   the same as an EXISTS semi-join    34.2s of 35.2s
    --
    -- In both the planner led with clicks_classification_scored_at_idx, read
    -- EVERY human click in the org (195,235 rows), and did a links_pkey heap
    -- fetch for each at 0.276ms — 54s of random I/O, parallelised down to 34s.
    -- The window never constrained it, so the cost did not depend on how much
    -- data was being reported on.
    --
    -- Scanning links by stage_id reads roughly the same number of rows, but a
    -- stage's links were inserted together so their heap pages are adjacent,
    -- and the per-link probe into clicks_link_id_idx is index-only for the ~97%
    -- of links nobody clicked.
    clicked AS (
      SELECT DISTINCT lk.stage_id, lk.contact_id
      FROM links lk
      WHERE lk.org_id = ${org}
        AND lk.stage_id IN (SELECT stage_id FROM all_win_stages)
        AND EXISTS (
          SELECT 1 FROM clicks ck
          WHERE ck.link_id = lk.id AND ck.org_id = ${org} AND ${HUMAN_CLICK}
        )
    ),
    -- Ledger primary; the legacy column fills only where NO ledger row exists.
    --
    -- ⚠️ ONE GROUPED PASS, NOT THREE CORRELATED SUBQUERIES PER SEND. The first
    -- version asked "is there a purchase / is there any event / sum the
    -- revenue" for each send separately, plus a fourth subquery that looked
    -- sale_status up on stage_sends BY PRIMARY KEY — a column already on the
    -- row that sent had selected. At 323K sends in a 7-day window the planner
    -- nested-loops all of it: 59.8s. Grouped and hash-joined it is one scan of
    -- the window's conversion_events.
    ledger AS (
      SELECT ce.stage_send_id AS id,
             bool_or(${purchasedClause()}) AS purchased,
             coalesce(sum(ce.revenue) FILTER (
               WHERE et.counts_revenue AND ce.status = 'approved'
             ), 0) AS revenue
      FROM conversion_events ce
      JOIN event_types et ON et.id = ce.event_type_id
      WHERE ce.org_id = ${org}
        AND ce.stage_send_id IN (SELECT id FROM lc_sent)
      GROUP BY 1
    ),
    opted AS (
      SELECT DISTINCT oa.stage_send_id AS id
      FROM opt_out_attributions oa
      WHERE oa.org_id = ${org} AND oa.stage_send_id IN (SELECT id FROM lc_sent)
    ),
    per_send AS (
      SELECT s.id, s.cohort, s.reconstructed,
             (cl.stage_id IS NOT NULL) AS clicked,
             -- A send with ledger rows but no purchase is NOT a sale: the
             -- ledger is primary, and it has answered. sale_status is consulted
             -- only where the ledger is silent (lg.id IS NULL).
             CASE
               WHEN lg.purchased THEN 1
               WHEN lg.id IS NULL AND s.sale_status IN ('lead', 'sale') THEN 1
               ELSE 0
             END AS is_sale,
             coalesce(lg.revenue, 0) AS ledger_revenue,
             (op.id IS NOT NULL) AS opted_out,
             -- The stage cost model at send grain: rate × (1 + opted out).
             coalesce(s.cost_per_sms, r.rate, 0)
               * (1 + CASE WHEN op.id IS NOT NULL THEN 1 ELSE 0 END) AS cost
      FROM lc_sent s
      LEFT JOIN clicked cl
             ON cl.stage_id = s.stage_id AND cl.contact_id = s.contact_id
      LEFT JOIN ledger lg ON lg.id = s.id
      LEFT JOIN opted op ON op.id = s.id
      LEFT JOIN stage_rate r ON r.stage_id = s.stage_id
    )
    SELECT coalesce(cohort, '__unclassified__') AS row,
           count(*)::int AS sends,
           count(*) FILTER (WHERE clicked)::int AS clickers,
           sum(is_sale)::int AS sales,
           coalesce(sum(ledger_revenue), 0)::text AS revenue,
           count(*) FILTER (WHERE opted_out)::int AS opt_outs,
           coalesce(sum(cost), 0)::text AS cost,
           bool_or(coalesce(reconstructed, false)) AS reconstructed
    FROM per_send
    GROUP BY 1
  `;
}

function foldLifecycleRows(
  rows: LifecycleReportRow[],
  from: string,
  to: string,
): LifecycleReport {
  const by = new Map(rows.map((r) => [r.row, r]));
  const zero = {
    sends: 0, clickers: 0, sales: 0, revenue: "0",
    opt_outs: 0, cost: "0", reconstructed: false,
  };
  const pick = (k: string) => by.get(k) ?? zero;

  const build = (row: LifecycleRow, keys: string[]): LifecycleMetrics => {
    const parts = keys.map(pick);
    const sends = parts.reduce((a, p) => a + Number(p.sends), 0);
    const clickers = parts.reduce((a, p) => a + Number(p.clickers), 0);
    const sales = parts.reduce((a, p) => a + Number(p.sales), 0);
    const opt_outs = parts.reduce((a, p) => a + Number(p.opt_outs), 0);
    const revenue = parts.reduce((a, p) => a + Number(p.revenue), 0);
    const cost = parts.reduce((a, p) => a + Number(p.cost), 0);
    return {
      row,
      sends,
      clickers,
      // ⚠️ null, not 0, when there is nothing to divide by — a 0% CTR on zero
      // sends is a statement nobody measured.
      ctr: sends > 0 ? clickers / sends : null,
      sales,
      cr: clickers > 0 ? sales / clickers : null,
      revenue: revenue.toFixed(4),
      opt_outs,
      opt_out_rate: sends > 0 ? opt_outs / sends : null,
      cost: cost.toFixed(4),
      reconstructed: parts.some((p) => p.reconstructed),
    };
  };

  const cohortRows = LIFECYCLE_COHORTS.map((c) => build(c, [c]));
  const clickers = build("clickers", ["hot", "warm"]);
  const nonClickers = build("non_clickers", ["new", "cold", "freeze", "suppressed"]);
  const total = build("total", [...LIFECYCLE_COHORTS]);
  // ⚠️ A REAL ROW, not an omission. Sends with no stamp predate the backfill;
  // leaving them out would make the cohorts silently fail to sum to Total and
  // a reader would assume the tool was broken rather than that history is
  // missing.
  const unclassified = build("unclassified", ["__unclassified__"]);

  const all = [...cohortRows, clickers, nonClickers, total, unclassified];
  return {
    rows: all,
    has_reconstructed: all.some((r) => r.reconstructed),
    from,
    to,
  };
}
