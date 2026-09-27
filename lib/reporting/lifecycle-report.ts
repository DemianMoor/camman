import "server-only";

import { sql } from "drizzle-orm";

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
  const { orgId, from, to } = opts;
  const org = sql`${orgId}::uuid`;

  const rows = (await db.execute(sql`
    WITH sent AS (
      SELECT ss.id, ss.contact_id, ss.stage_id, ss.sent_at, ss.cost_per_sms,
             l.status AS cohort, l.reconstructed
      FROM stage_sends ss
      LEFT JOIN stage_send_lifecycle l
             ON l.stage_send_id = ss.id AND l.org_id = ${org}
      WHERE ss.org_id = ${org} AND ss.status = 'sent'
        AND (ss.sent_at AT TIME ZONE 'America/New_York')::date
            BETWEEN ${from}::date AND ${to}::date
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
    stage_rate AS (
      SELECT cs.id AS stage_id,
             CASE WHEN d.denom > 0 THEN cs.total_cost / d.denom ELSE 0 END AS rate
      FROM campaign_stages cs
      CROSS JOIN LATERAL (
        SELECT greatest(
                 cs.sms_count,
                 (SELECT count(*) FROM stage_sends x
                  WHERE x.stage_id = cs.id AND x.status = 'sent')
               ) + cs.opt_out_count AS denom
      ) d
      WHERE cs.org_id = ${org}
        AND cs.id IN (SELECT DISTINCT stage_id FROM sent)
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
    clicked AS (
      SELECT DISTINCT s.id
      FROM sent s
      JOIN links lk
            ON lk.stage_id = s.stage_id
           AND lk.contact_id = s.contact_id
           AND lk.org_id = ${org}
      JOIN clicks ck ON ck.link_id = lk.id
      WHERE ${HUMAN_CLICK} AND ck.org_id = ${org}
    ),
    -- Ledger primary; the legacy columns fill only where no ledger row exists.
    sales AS (
      SELECT s.id,
             CASE WHEN EXISTS (
               SELECT 1 FROM conversion_events ce
               WHERE ce.org_id = ${org} AND ce.stage_send_id = s.id
                 AND ${purchasedClause()}
             ) THEN 1
             WHEN NOT EXISTS (
                 SELECT 1 FROM conversion_events ce2
                 WHERE ce2.org_id = ${org} AND ce2.stage_send_id = s.id)
               AND EXISTS (
                 SELECT 1 FROM stage_sends ls
                 WHERE ls.org_id = ${org} AND ls.id = s.id
                   AND ls.sale_status IN ('lead', 'sale')
               ) THEN 1
             ELSE 0 END AS is_sale,
             coalesce((
               SELECT sum(ce.revenue) FROM conversion_events ce
               JOIN event_types et ON et.id = ce.event_type_id
               WHERE ce.org_id = ${org} AND ce.stage_send_id = s.id
                 AND et.counts_revenue AND ce.status = 'approved'
             ), 0) AS ledger_revenue
      FROM sent s
    ),
    opted AS (
      SELECT DISTINCT oa.stage_send_id AS id
      FROM opt_out_attributions oa
      WHERE oa.org_id = ${org} AND oa.stage_send_id IN (SELECT id FROM sent)
    ),
    per_send AS (
      SELECT s.id, s.cohort, s.reconstructed,
             (cl.id IS NOT NULL) AS clicked,
             sa.is_sale, sa.ledger_revenue,
             (op.id IS NOT NULL) AS opted_out,
             -- The stage cost model at send grain: rate × (1 + opted out).
             coalesce(s.cost_per_sms, r.rate, 0)
               * (1 + CASE WHEN op.id IS NOT NULL THEN 1 ELSE 0 END) AS cost
      FROM sent s
      LEFT JOIN clicked cl ON cl.id = s.id
      LEFT JOIN sales sa ON sa.id = s.id
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
  `)) as unknown as {
    row: string;
    sends: number;
    clickers: number;
    sales: number;
    revenue: string;
    opt_outs: number;
    cost: string;
    reconstructed: boolean;
  }[];

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
