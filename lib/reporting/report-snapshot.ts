import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { salesRevenueTotals } from "@/lib/reporting/attribution";

// Snapshot of the five headline performance metrics over one ET calendar day,
// aggregated across ALL organizations (this tool is single-org in practice; the
// scheduled Telegram report has no user session to scope by, so it reports the
// whole business). Powers app/api/cron/telegram-report.
//
// Day-attribution basis matches the /reports page and dashboard exactly so the
// Telegram numbers reconcile with the UI:
//   • sales / revenue → conversion-dated via salesRevenueTotals (Keitaro
//     stat_date ∨ manual-tally entry date, max-deduped per stage).
//   • spend           → Σ campaign_stages.total_cost attributed to the stage's
//     send moment (sent_at) — the same rule /reports uses for Cost.
//   • opt-outs        → count of opt_outs (reason='opt_out') by created_at.
//   • delivered       → stage_sends accepted by the provider (status='sent') by
//     sent_at. CamMan does NOT poll DLR (out of scope), so "delivered" here is
//     "provider-accepted" — the closest real signal for the opt-out ratio.

export interface ReportMetrics {
  sales: number;
  revenue: number;
  spend: number;
  optOuts: number;
  delivered: number;
  // (revenue - spend) / spend * 100. Null when spend == 0 (rendered "n/a").
  roiPct: number | null;
}

// One ET calendar day expressed both as ET date strings (for the stat_date
// filter, which is already an ET date) and as UTC instants (for created_at /
// sent_at range filters). Half-open: [from, toExclusive).
export interface EtDayRange {
  statDateFrom: string; // 'YYYY-MM-DD' ET, inclusive
  statDateToExclusive: string; // 'YYYY-MM-DD' ET, exclusive
  fromUtc: Date;
  toExclusiveUtc: Date;
}

// Build an EtDayRange from the DST-safe UTC bounds of an ET calendar day (as
// returned by campaignDayBoundsUtc). `start` is ET midnight of the day; `end`
// is ET midnight of the next day.
export function etDayRange(bounds: { start: Date; end: Date }): EtDayRange {
  return {
    statDateFrom: formatInCampaignTimezone(bounds.start, "yyyy-MM-dd"),
    statDateToExclusive: formatInCampaignTimezone(bounds.end, "yyyy-MM-dd"),
    fromUtc: bounds.start,
    toExclusiveUtc: bounds.end,
  };
}

// Sum campaign_stages.total_cost across all orgs for stages sent within the
// window. Archived stages excluded — matches salesRevenueTotals.
async function spendInRange(range: EtDayRange): Promise<number> {
  const rows = (await db.execute(sql`
    select coalesce(sum(cs.total_cost), 0)::numeric(12,4)::text as spend
    from campaign_stages cs
    where cs.archived_at is null
      and cs.sent_at >= ${range.fromUtc.toISOString()}::timestamptz
      and cs.sent_at <  ${range.toExclusiveUtc.toISOString()}::timestamptz
  `)) as unknown as { spend: string }[];
  return Number(rows[0]?.spend ?? 0);
}

// Count opt-out events (reason='opt_out') across all orgs by created_at.
async function optOutsInRange(range: EtDayRange): Promise<number> {
  const rows = (await db.execute(sql`
    select count(*)::int as n
    from opt_outs oo
    where oo.reason = 'opt_out'
      and oo.created_at >= ${range.fromUtc.toISOString()}::timestamptz
      and oo.created_at <  ${range.toExclusiveUtc.toISOString()}::timestamptz
  `)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

// Count provider-accepted sends (status='sent') across all orgs by sent_at.
async function deliveredInRange(range: EtDayRange): Promise<number> {
  const rows = (await db.execute(sql`
    select count(*)::int as n
    from stage_sends ss
    where ss.status = 'sent'
      and ss.sent_at >= ${range.fromUtc.toISOString()}::timestamptz
      and ss.sent_at <  ${range.toExclusiveUtc.toISOString()}::timestamptz
  `)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

// Sales + revenue across all orgs, summed from the per-org attribution helper so
// the max-dedupe (Keitaro ∨ manual) is applied within each org. A stage belongs
// to exactly one org, so summing per-org totals is the correct business total.
async function salesRevenueAllOrgs(
  range: EtDayRange,
): Promise<{ sales: number; revenue: number }> {
  const orgRows = (await db.execute(sql`
    select id::text as id from organizations
  `)) as unknown as { id: string }[];

  let sales = 0;
  let revenue = 0;
  for (const { id } of orgRows) {
    const t = await salesRevenueTotals({
      orgId: id,
      statDateFrom: range.statDateFrom,
      statDateToExclusive: range.statDateToExclusive,
      manualFromUtc: range.fromUtc,
      manualToExclusiveUtc: range.toExclusiveUtc,
    });
    sales += t.sales;
    revenue += Number(t.revenue);
  }
  return { sales, revenue };
}

export async function computeReportMetrics(
  range: EtDayRange,
): Promise<ReportMetrics> {
  const [{ sales, revenue }, spend, optOuts, delivered] = await Promise.all([
    salesRevenueAllOrgs(range),
    spendInRange(range),
    optOutsInRange(range),
    deliveredInRange(range),
  ]);

  return {
    sales,
    revenue,
    spend,
    optOuts,
    delivered,
    roiPct: spend > 0 ? ((revenue - spend) / spend) * 100 : null,
  };
}
