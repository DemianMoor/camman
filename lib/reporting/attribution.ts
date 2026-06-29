import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";

// ============================================================================
// Sales & revenue attribution basis — SINGLE SOURCE OF TRUTH.
//
// Sales and revenue are attributed to the CONVERSION DATE, not the day the SMS
// went out. Conversions lag sends (a sale on Jun 23 can come from a Jun 21
// send), so "by send day" and "by conversion day" disagree — and different
// reports silently picking different windows is exactly the bug this module
// exists to kill. Every sales/revenue figure that is grouped or filtered by
// date routes through here so they all agree with the per-stage Keitaro
// results UI (/reports).
//
//   ATTRIBUTION_BASIS = 'stat_date'
//
//   • Revenue           → keitaro_stage_results.revenue, bucketed by stat_date.
//                         100% Keitaro (the real per-conversion payout recorded
//                         at sync time) — there is no manual revenue, so revenue
//                         is purely conversion-dated.
//   • Keitaro sales     → keitaro_stage_results.sales, bucketed by stat_date.
//
// stat_date is genuinely the CONVERSION DAY for the sales/revenue/checkout columns:
// lib/keitaro/poll.ts sources those from Keitaro's conversions/log (one row per
// conversion, dated by the conversion's own `datetime`), NOT from report/build —
// whose `day` grouping attributes a conversion to the originating CLICK's day. The
// click/visit/redirect columns on the same row are still click-dated (a click
// happens on the click day). Until 2026-06-29 sales were mistakenly click-dated
// (report/build), so a sale showed on the campaign/click day, not the sale day.
//   • Manual sales      → stage_manual_sales.delta, bucketed by the ledger entry
//                         date (created_at). A manually-tallied sale has no
//                         Keitaro conversion timestamp, so its ledger entry date
//                         is the closest available proxy for "when the sale
//                         happened". (Historical pre-ledger sales were re-dated
//                         to each stage's send day in migration 0084.)
//
// stat_date is ALREADY an ET calendar date — lib/keitaro/poll.ts queries Keitaro
// with timezone = America/New_York — so filtering/grouping on it needs no
// conversion. The manual ledger stores created_at as timestamptz; we bucket it
// into ET days with `AT TIME ZONE CAMPAIGN_TIMEZONE`.
//
// Keitaro and manual counts are combined per stage with combineSales() (max, not
// sum): a sale that Keitaro tracked AND the operator tallied is the SAME sale, so
// summing double-counts it. See combineSales in lib/stage-results.ts.
// ============================================================================
export const ATTRIBUTION_BASIS = "stat_date" as const;

// Inclusive-start / exclusive-end ET day strings for the Keitaro (stat_date)
// side, plus the matching UTC instants for the manual-ledger (created_at) side.
export interface AttributionRange {
  orgId: string;
  // ET calendar day, "YYYY-MM-DD". stat_date filter is [statDateFrom, statDateToExclusive).
  statDateFrom: string;
  statDateToExclusive: string;
  // UTC instants for the manual ledger's created_at: [manualFromUtc, manualToExclusiveUtc).
  manualFromUtc: Date;
  manualToExclusiveUtc: Date;
}

// Per-stage combined sales/revenue totals for the whole range. Sales =
// Σ_stage max(manual-in-range, keitaro-in-range); revenue = Σ keitaro revenue
// (stat_date in range). Archived stages are excluded. Powers the dashboard
// stat tiles (Income / Sales / ROI).
export async function salesRevenueTotals(
  r: AttributionRange,
): Promise<{ sales: number; revenue: string }> {
  const rows = (await db.execute(sql`
    with k as (
      select ksr.stage_id,
             sum(ksr.sales)::int as k_sales,
             sum(ksr.revenue) as k_rev
      from keitaro_stage_results ksr
      join campaign_stages cs on cs.id = ksr.stage_id and cs.archived_at is null
      where ksr.org_id = ${r.orgId}::uuid
        and ksr.stat_date >= ${r.statDateFrom}::date
        and ksr.stat_date <  ${r.statDateToExclusive}::date
      group by ksr.stage_id
    ),
    m as (
      select sms.stage_id, sum(sms.delta)::int as m_sales
      from stage_manual_sales sms
      join campaign_stages cs on cs.id = sms.stage_id and cs.archived_at is null
      where sms.org_id = ${r.orgId}::uuid
        and sms.created_at >= ${r.manualFromUtc.toISOString()}::timestamptz
        and sms.created_at <  ${r.manualToExclusiveUtc.toISOString()}::timestamptz
      group by sms.stage_id
    ),
    per_stage as (
      select greatest(coalesce(m.m_sales, 0), coalesce(k.k_sales, 0)) as sales,
             coalesce(k.k_rev, 0) as revenue
      from k full outer join m on k.stage_id = m.stage_id
    )
    select coalesce(sum(sales), 0)::int as sales,
           coalesce(sum(revenue), 0)::numeric(12,4)::text as revenue
    from per_stage
  `)) as unknown as { sales: number; revenue: string }[];
  return rows[0] ?? { sales: 0, revenue: "0" };
}

// Per-ET-day combined sales/revenue, keyed "YYYY-MM-DD". Per (stage, day) we take
// max(manual, keitaro) then sum across stages, so the daily dedupe matches the
// range total. Powers the dashboard "Income per day" chart.
export async function salesRevenueByDay(
  r: AttributionRange,
): Promise<Map<string, { sales: number; revenue: number }>> {
  const rows = (await db.execute(sql`
    with k as (
      select ksr.stage_id,
             ksr.stat_date::text as day,
             sum(ksr.sales)::int as k_sales,
             sum(ksr.revenue) as k_rev
      from keitaro_stage_results ksr
      join campaign_stages cs on cs.id = ksr.stage_id and cs.archived_at is null
      where ksr.org_id = ${r.orgId}::uuid
        and ksr.stat_date >= ${r.statDateFrom}::date
        and ksr.stat_date <  ${r.statDateToExclusive}::date
      group by ksr.stage_id, ksr.stat_date
    ),
    m as (
      select sms.stage_id,
             to_char((sms.created_at at time zone ${CAMPAIGN_TIMEZONE})::date, 'YYYY-MM-DD') as day,
             sum(sms.delta)::int as m_sales
      from stage_manual_sales sms
      join campaign_stages cs on cs.id = sms.stage_id and cs.archived_at is null
      where sms.org_id = ${r.orgId}::uuid
        and sms.created_at >= ${r.manualFromUtc.toISOString()}::timestamptz
        and sms.created_at <  ${r.manualToExclusiveUtc.toISOString()}::timestamptz
      group by sms.stage_id, 2
    ),
    per_stage_day as (
      select coalesce(k.day, m.day) as day,
             greatest(coalesce(m.m_sales, 0), coalesce(k.k_sales, 0)) as sales,
             coalesce(k.k_rev, 0) as revenue
      from k full outer join m on k.stage_id = m.stage_id and k.day = m.day
    )
    select day,
           coalesce(sum(sales), 0)::int as sales,
           coalesce(sum(revenue), 0)::numeric(12,4)::text as revenue
    from per_stage_day
    group by day
  `)) as unknown as { day: string; sales: number; revenue: string }[];
  return new Map(
    rows.map((row) => [
      row.day,
      { sales: row.sales, revenue: Number(row.revenue) },
    ]),
  );
}

// Manual sales per stage whose ledger entry date (created_at) falls in the given
// UTC window. Returns stage_id → Σ delta. Used by /reports to combine the manual
// tally (by entry date) with the Keitaro conversion count (by stat_date) it
// already folds per stage. No archived filter — the caller restricts the stage set.
export async function manualSalesByStageInRange(args: {
  orgId: string;
  fromUtc: Date;
  toExclusiveUtc: Date;
}): Promise<Map<number, number>> {
  const rows = (await db.execute(sql`
    select sms.stage_id, sum(sms.delta)::int as m_sales
    from stage_manual_sales sms
    where sms.org_id = ${args.orgId}::uuid
      and sms.created_at >= ${args.fromUtc.toISOString()}::timestamptz
      and sms.created_at <  ${args.toExclusiveUtc.toISOString()}::timestamptz
    group by sms.stage_id
  `)) as unknown as { stage_id: number; m_sales: number }[];
  return new Map(rows.map((row) => [row.stage_id, row.m_sales]));
}
