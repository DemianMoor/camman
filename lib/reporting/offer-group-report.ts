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

export type OfferGroupReport = {
  rows: GroupRawRow[];
  orgBenchmark: RawMetrics;
  refreshedAt: string | null;
};

const ZERO: RawMetrics = { sends: 0, revenue: 0, sales: 0, clicks: 0, cost: 0, optouts: 0 };

// Read the precomputed report for one offer, org-scoped. Sorting is done client-side
// (tiny row set), so no ORDER BY here.
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

  const benchRows = (await db.execute(sql`
    select sends, revenue, sales, clicks, cost, optouts
    from offer_report_org_summary_mv
    where org_id = ${orgId}::uuid
  `)) as unknown as Record<string, unknown>[];

  const logRows = (await db.execute(sql`
    select refreshed_at from report_refresh_log
    where view_name = 'offer_group_report_mv'
  `)) as unknown as { refreshed_at: string | null }[];

  const n = (v: unknown) => Number(v ?? 0);
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
    refreshedAt: logRows[0]?.refreshed_at
      ? new Date(logRows[0].refreshed_at).toISOString()
      : null,
  };
}

// Rebuild both matviews (CONCURRENTLY — non-blocking) and stamp the refresh log.
// Called by the twice-daily cron. CONCURRENTLY must run outside a transaction, so
// each statement is its own execute() call.
export async function refreshOfferGroupReport(): Promise<void> {
  await db.execute(sql`refresh materialized view concurrently offer_report_org_summary_mv`);
  await db.execute(sql`refresh materialized view concurrently offer_group_report_mv`);
  await db.execute(sql`
    update report_refresh_log set refreshed_at = now()
    where view_name in ('offer_group_report_mv', 'offer_report_org_summary_mv')
  `);
}
