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
  // Approved-only revenue is RawMetrics.revenue; this is the same money still in
  // lifecycle status `pending` (a held conversion). A SEPARATE figure — never
  // added into revenue, and never in EPC / RPM / net profit.
  pending_revenue: number;
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
  // The group rows' revenue/sales and these three come from the conversion_events
  // ledger (one row per conversion, joined on stage_send_id); this row's
  // `revenue`/`sales` come from Keitaro's per-stage aggregate — and for sales
  // GREATEST(keitaro, manual). The two bases still differ: the ledger can only
  // place a conversion whose RECIPIENT resolved, while the stage-day projection
  // also counts conversions known only at stage level. So a group row still
  // reads a little lower than its share of the footer.
  // NOT a whole-and-part pair with revenue/sales — do not subtract them.
  attributable_revenue: number;
  attributable_sales: number;
  attributable_pending_revenue: number;
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
    select group_id, group_name, sends, revenue, pending_revenue, sales, clicks, cost, optouts,
           sent_7d, sent_30d, sent_90d, fresh_pool
    from offer_group_report_mv
    where org_id = ${orgId}::uuid and offer_id = ${offerId}
  `)) as unknown as Record<string, unknown>[];

  // Separate matview, not groupRows[0]: an offer whose sends were all recorded
  // outside the app has NO group rows, and still needs a footer.
  const totalsRows = (await db.execute(sql`
    select sends, revenue, sales, clicks, cost, optouts, has_manual_stages,
           attributable_sends, unattributed_sends,
           attributable_revenue, attributable_sales, attributable_pending_revenue
    from offer_report_offer_totals_mv
    where org_id = ${orgId}::uuid and offer_id = ${offerId}
  `)) as unknown as Record<string, unknown>[];

  const { orgBenchmark, benchmarkHasManual } = await readOrgBenchmark(orgId);
  const refreshedAt = await readGroupReportRefreshedAt();

  const n = (v: unknown) => Number(v ?? 0);
  const t = totalsRows[0];
  return {
    rows: groupRows.map((r) => ({
      group_id: n(r.group_id),
      group_name: String(r.group_name),
      sends: n(r.sends),
      revenue: n(r.revenue),
      pending_revenue: n(r.pending_revenue),
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
          attributable_pending_revenue: n(t.attributable_pending_revenue),
        }
      : {
          ...ZERO,
          has_manual_stages: false,
          attributable_sends: 0,
          unattributed_sends: 0,
          attributable_revenue: 0,
          attributable_sales: 0,
          attributable_pending_revenue: 0,
        },
    orgBenchmark,
    benchmarkHasManual,
    refreshedAt,
  };
}

// The de-duplicated org-wide benchmark row. Shared with the Audience Stats
// report (lib/reporting/audience-report.ts) so both screens read one definition.
export async function readOrgBenchmark(
  orgId: string,
): Promise<{ orgBenchmark: RawMetrics; benchmarkHasManual: boolean }> {
  const benchRows = (await db.execute(sql`
    select sends, revenue, sales, clicks, cost, optouts, has_manual_stages
    from offer_report_org_summary_mv
    where org_id = ${orgId}::uuid
  `)) as unknown as Record<string, unknown>[];

  const n = (v: unknown) => Number(v ?? 0);
  const b = benchRows[0];
  return {
    orgBenchmark: b
      ? {
          sends: n(b.sends),
          revenue: n(b.revenue),
          sales: n(b.sales),
          clicks: n(b.clicks),
          cost: n(b.cost),
          optouts: n(b.optouts),
        }
      : { ...ZERO },
    benchmarkHasManual: Boolean(b?.has_manual_stages),
  };
}

// "Data as of" for both group reports: offer_group_report_mv's refresh. The
// Audience Stats totals matview is derived from it and refreshed moments later
// in the same cron run, so this one stamp is honest for both.
export async function readGroupReportRefreshedAt(): Promise<string | null> {
  const logRows = (await db.execute(sql`
    select refreshed_at from report_refresh_log
    where view_name = 'offer_group_report_mv'
  `)) as unknown as { refreshed_at: string | null }[];
  return logRows[0]?.refreshed_at
    ? new Date(logRows[0].refreshed_at).toISOString()
    : null;
}

export type RefreshDurations = {
  totalsMs: number;
  summaryMs: number;
  groupMs: number;
  audienceTotalsMs: number;
  totalMs: number;
};

// Rebuild all four matviews (CONCURRENTLY -- non-blocking) and stamp the
// refresh log. Called by the twice-daily cron. CONCURRENTLY must run outside a
// transaction, so each statement is its own execute() call.
//
// offer_report_offer_totals_mv (introduced in migration 0132) refreshes after
// the two 0093 matviews, not for a cosmetic footer-freshness reason, but for
// deploy-order blast radius: this code and 0132 are meant to deploy together
// (0132 first, per CLAUDE.md §14), but if this code ever ships before 0132
// applies, the `offer_report_offer_totals_mv` statement is the one that throws
// (relation does not exist). With it after them, the two PRE-EXISTING matviews
// (offer_report_org_summary_mv, offer_group_report_mv -- both from 0093,
// refreshed by this function since before 0132 existed) still refresh and
// stay live before the throw ends the invocation. Refreshing it first would
// mean the throw happens before either of the other two statements run, so a
// code-before-migration deploy would freeze ALL THREE reports at their last
// snapshot (twice-daily cron, so potentially days) instead of just one.
// Measured 2026-08-13: summary ~11s, group ~25s, totals ~4.5s -- ~40.5s
// against a 300s ceiling.
//
// audience_report_group_totals_mv (migration 0180, Audience Stats) refreshes
// LAST, for two reasons that agree: it sums offer_group_report_mv, so it must
// follow that refresh; and by the same blast-radius reasoning, a deploy that
// precedes 0180 throws on this final statement, after the other three have
// refreshed and been stamped.
//
// Each view's report_refresh_log row is stamped immediately after that
// view's OWN refresh succeeds, not once at the end after all of them. If a
// LATER refresh throws -- precisely the code-before-migration case the
// ordering above exists for -- the ones that DID refresh are correctly marked
// fresh instead of the page reporting "a refresh was missed" over data that is
// actually seconds old.
export async function refreshOfferGroupReport(): Promise<RefreshDurations> {
  const t0 = Date.now();
  await db.execute(sql`refresh materialized view concurrently offer_report_org_summary_mv`);
  const t1 = Date.now();
  await db.execute(sql`
    update report_refresh_log set refreshed_at = now() where view_name = 'offer_report_org_summary_mv'
  `);

  await db.execute(sql`refresh materialized view concurrently offer_group_report_mv`);
  const t2 = Date.now();
  await db.execute(sql`
    update report_refresh_log set refreshed_at = now() where view_name = 'offer_group_report_mv'
  `);

  await db.execute(sql`refresh materialized view concurrently offer_report_offer_totals_mv`);
  const t3 = Date.now();
  await db.execute(sql`
    update report_refresh_log set refreshed_at = now() where view_name = 'offer_report_offer_totals_mv'
  `);

  await db.execute(sql`refresh materialized view concurrently audience_report_group_totals_mv`);
  const t4 = Date.now();
  await db.execute(sql`
    update report_refresh_log set refreshed_at = now() where view_name = 'audience_report_group_totals_mv'
  `);

  return {
    summaryMs: t1 - t0,
    groupMs: t2 - t1,
    totalsMs: t3 - t2,
    audienceTotalsMs: t4 - t3,
    totalMs: Date.now() - t0,
  };
}
