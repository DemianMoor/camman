import { sql } from "drizzle-orm";

import { db } from "@/db/client";

// No `"server-only"` import: this module is also exercised directly by
// scripts/test-offer-group-report-helper.ts (a plain Node/tsx entry point,
// same pattern as lib/tracking-id.ts). It holds no secrets — just SQL over
// the shared matviews — and its sibling lib/reporting/attribution.ts follows
// the same convention for the same reason.

export type RawMetrics = {
  sends: number;
  revenue: number;
  sales: number;
  clicks: number;
  cost: number;
  optouts: number;
};

export type GroupRawRow = RawMetrics & {
  group_id: number;
  group_name: string;
  sent_7d: number;
  sent_30d: number;
  sent_90d: number;
  fresh_pool: number;
};

// Offer grain. Read from its own matview rather than summed from the group
// rows: those are per-recipient full counts and a contact in three of the
// offer's groups appears in three of them. Summing was the defect 0132 removed.
export type OfferTotals = RawMetrics & {
  has_manual_stages: boolean;
  attributable_sends: number;
  // sends - attributable_sends: recorded outside the app, from a non-tracked
  // or untargeted campaign, or sent to a recipient outside its targeted groups.
  unattributed_sends: number;
  // The group rows' revenue/sales come from a DIFFERENT source than this row's:
  // per-recipient stage_sends.sale_revenue / converted_at, versus Keitaro's
  // per-stage aggregate (and GREATEST(keitaro, manual) for sales). Coverage is
  // ~97% of revenue and ~90% of sales, so a group row is systematically a little
  // lower than its share of the footer. These two carry the same figures on the
  // group rows' basis so the gap is visible instead of being read as a shortfall.
  // NOT a whole-and-part pair with revenue/sales — do not subtract them.
  attributable_revenue: number;
  attributable_sales: number;
};

export type OfferGroupReport = {
  rows: GroupRawRow[];
  offerTotals: OfferTotals;
  orgBenchmark: RawMetrics;
  benchmarkHasManual: boolean;
  refreshedAt: string | null;
};

const ZERO: RawMetrics = { sends: 0, revenue: 0, sales: 0, clicks: 0, cost: 0, optouts: 0 };

// Read the precomputed report for one offer, org-scoped. Sorting is done
// client-side (tiny row set), so no ORDER BY here.
export async function getOfferGroupReport(
  orgId: string,
  offerId: number,
): Promise<OfferGroupReport> {
  const groupRows = (await db.execute(sql`
    select group_id, group_name, sends, revenue, sales, clicks, cost, optouts,
           sent_7d, sent_30d, sent_90d, fresh_pool
    from offer_group_report_mv
    where org_id = ${orgId}::uuid and offer_id = ${offerId}
  `)) as unknown as Record<string, unknown>[];

  // Separate matview, not groupRows[0]: an offer whose sends were all recorded
  // outside the app has NO group rows, and still needs a footer.
  const totalsRows = (await db.execute(sql`
    select sends, revenue, sales, clicks, cost, optouts, has_manual_stages,
           attributable_sends, unattributed_sends,
           attributable_revenue, attributable_sales
    from offer_report_offer_totals_mv
    where org_id = ${orgId}::uuid and offer_id = ${offerId}
  `)) as unknown as Record<string, unknown>[];

  const benchRows = (await db.execute(sql`
    select sends, revenue, sales, clicks, cost, optouts, has_manual_stages
    from offer_report_org_summary_mv
    where org_id = ${orgId}::uuid
  `)) as unknown as Record<string, unknown>[];

  const logRows = (await db.execute(sql`
    select refreshed_at from report_refresh_log
    where view_name = 'offer_group_report_mv'
  `)) as unknown as { refreshed_at: string | null }[];

  const n = (v: unknown) => Number(v ?? 0);
  const t = totalsRows[0];
  return {
    rows: groupRows.map((r) => ({
      group_id: n(r.group_id),
      group_name: String(r.group_name),
      sends: n(r.sends),
      revenue: n(r.revenue),
      sales: n(r.sales),
      clicks: n(r.clicks),
      cost: n(r.cost),
      optouts: n(r.optouts),
      sent_7d: n(r.sent_7d),
      sent_30d: n(r.sent_30d),
      sent_90d: n(r.sent_90d),
      fresh_pool: n(r.fresh_pool),
    })),
    offerTotals: t
      ? {
          sends: n(t.sends),
          revenue: n(t.revenue),
          sales: n(t.sales),
          clicks: n(t.clicks),
          cost: n(t.cost),
          optouts: n(t.optouts),
          has_manual_stages: Boolean(t.has_manual_stages),
          attributable_sends: n(t.attributable_sends),
          unattributed_sends: n(t.unattributed_sends),
          attributable_revenue: n(t.attributable_revenue),
          attributable_sales: n(t.attributable_sales),
        }
      : {
          ...ZERO,
          has_manual_stages: false,
          attributable_sends: 0,
          unattributed_sends: 0,
          attributable_revenue: 0,
          attributable_sales: 0,
        },
    orgBenchmark: benchRows[0]
      ? {
          sends: n(benchRows[0].sends),
          revenue: n(benchRows[0].revenue),
          sales: n(benchRows[0].sales),
          clicks: n(benchRows[0].clicks),
          cost: n(benchRows[0].cost),
          optouts: n(benchRows[0].optouts),
        }
      : { ...ZERO },
    benchmarkHasManual: Boolean(benchRows[0]?.has_manual_stages),
    refreshedAt: logRows[0]?.refreshed_at
      ? new Date(logRows[0].refreshed_at).toISOString()
      : null,
  };
}

export type RefreshDurations = {
  totalsMs: number;
  summaryMs: number;
  groupMs: number;
  totalMs: number;
};

// Rebuild all three matviews (CONCURRENTLY -- non-blocking) and stamp the
// refresh log. Called by the twice-daily cron. CONCURRENTLY must run outside a
// transaction, so each statement is its own execute() call.
//
// The group matview reads no other matview, so order is not load-bearing; the
// totals matview goes first only so the footer is never newer than the rows a
// reader is looking at. Measured 2026-08-13: totals ~4.5s, summary ~11s, group
// ~25s -- ~40.5s against a 300s ceiling.
export async function refreshOfferGroupReport(): Promise<RefreshDurations> {
  const t0 = Date.now();
  await db.execute(sql`refresh materialized view concurrently offer_report_offer_totals_mv`);
  const t1 = Date.now();
  await db.execute(sql`refresh materialized view concurrently offer_report_org_summary_mv`);
  const t2 = Date.now();
  await db.execute(sql`refresh materialized view concurrently offer_group_report_mv`);
  const t3 = Date.now();
  await db.execute(sql`
    update report_refresh_log set refreshed_at = now()
    where view_name in ('offer_group_report_mv', 'offer_report_org_summary_mv',
                        'offer_report_offer_totals_mv')
  `);
  return {
    totalsMs: t1 - t0,
    summaryMs: t2 - t1,
    groupMs: t3 - t2,
    totalMs: Date.now() - t0,
  };
}
