import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import { eventNum, type ReportEventMap } from "@/lib/reporting/event-columns";

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

/**
 * What salesRevenueTotals returns.
 *
 * `sales` and `revenue` are the headline figures and have not changed. The
 * other three are the Phase 5 split of the SAME window over the SAME stage set,
 * and they are returned TOGETHER because they only mean anything together:
 *
 *     sales = Σ events[t].n over is_purchase types + manual_topup + strays
 *
 * where `strays` are counted in `unmapped`. Take the per-event numbers without
 * the other two and the report under-explains its own total — see the
 * `keitaro_stage_results.events` comment in db/schema.ts, which states the same
 * identity at the stage-day grain.
 */
export interface SalesRevenueTotals {
  sales: number;
  /** numeric(12,4) as text — the caller decides how to parse it. Unchanged. */
  revenue: string;
  /** Per-event-type totals, keyed by event_types.key. Tracker events only. */
  events: ReportEventMap;
  /**
   * Conversions in the window the ORG-SCOPED event_types join could not place.
   * They are under no key of `events` — and NOT absent from the scalars beside
   * it: `sales` and `revenue` come from keitaro_stage_results' own columns,
   * which resolve is_purchase / counts_revenue through NON-org-scoped id lists
   * (lib/sale-attribution.ts), so a conversion carrying another organisation's
   * event type is already inside them. That difference is the whole reason this
   * field is carried. Summed from keitaro_stage_results.unmapped_conversions.
   */
  unmapped: number;
  /**
   * The part of `sales` the MANUAL tally contributed. `sales` is
   * greatest(manual, keitaro) per stage, so this is the excess of the manual
   * figure over the tracker's, summed — and it is exactly the gap between
   * Σ (is_purchase) n and `sales`, because the per-event numbers count tracker
   * events only.
   */
  manual_topup: number;
}

// Per-stage combined sales/revenue totals for the whole range. Sales =
// Σ_stage max(manual-in-range, keitaro-in-range); revenue = Σ keitaro revenue
// (stat_date in range). Archived stages are excluded. Powers the dashboard
// stat tiles (Income / Sales / ROI) and the scheduled Telegram report.
export async function salesRevenueTotals(
  r: AttributionRange,
): Promise<SalesRevenueTotals> {
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
    -- The per-event split of the SAME window over the SAME stage set. It reads
    -- the same table with the same archived_at filter as the k CTE above, so
    -- the split cannot describe a different set of stages from the number
    -- beside it. jsonb has no sum(), so the object is unrolled to (key, value)
    -- pairs and summed per key.
    --
    -- ⚠️ TWO GUARDS, AT TWO LEVELS, AND BOTH ARE LOAD-BEARING.
    --
    -- jsonb_typeof(ksr.events) = 'object' covers the TOP level: jsonb_each
    -- RAISES 22023 on a jsonb scalar or array and the error is NOT scoped to the
    -- offending row — it kills the whole statement.
    --
    -- eventNum() covers the VALUE level, which that guard does not reach: a row
    -- whose entry value is a bare string IS still an object, and the plain cast
    -- this used to use — (e.value ->> 'n')::numeric — raises 22P02
    -- statement-wide on it just the same. See lib/reporting/event-columns.ts
    -- for the measurements. (NO BACKTICKS: see the note further down — one
    -- inside this template literal TERMINATES it.)
    --
    -- The column is jsonb NOT NULL DEFAULT '{}' with NO CHECK constraint
    -- (migration 0185), so both object-ness and number-ness are conventions of
    -- the writer, not guarantees of the database. Here that matters more than
    -- anywhere else either guard has been fixed: this query backs the scheduled
    -- Telegram report, whose failure mode is a 500 EVERY HOUR until a human
    -- edits a row. Same pair, same reason, in
    -- lib/reporting/stage-keitaro-aggregate.ts and lib/creatives/metrics-cache.ts.
    -- Bars T19 (top level) and T19b (value level).
    ev as (
      select e.key as event_key,
             sum(${eventNum(sql`e.value`, "n")})::int as n,
             sum(${eventNum(sql`e.value`, "revenue")})::numeric(12,4) as revenue,
             sum(${eventNum(sql`e.value`, "pending_revenue")})::numeric(12,4) as pending_revenue
      from keitaro_stage_results ksr
      join campaign_stages cs on cs.id = ksr.stage_id and cs.archived_at is null
      cross join lateral jsonb_each(ksr.events) as e(key, value)
      where ksr.org_id = ${r.orgId}::uuid
        and ksr.stat_date >= ${r.statDateFrom}::date
        and ksr.stat_date <  ${r.statDateToExclusive}::date
        and jsonb_typeof(ksr.events) = 'object'
      group by 1
    ),
    -- The residual: conversions the org-scoped event_types join could not place.
    -- Counted as nothing anywhere else, which is exactly why it is carried.
    um as (
      select coalesce(sum(ksr.unmapped_conversions), 0)::int as n
      from keitaro_stage_results ksr
      join campaign_stages cs on cs.id = ksr.stage_id and cs.archived_at is null
      where ksr.org_id = ${r.orgId}::uuid
        and ksr.stat_date >= ${r.statDateFrom}::date
        and ksr.stat_date <  ${r.statDateToExclusive}::date
    ),
    per_stage as (
      select greatest(coalesce(m.m_sales, 0), coalesce(k.k_sales, 0)) as sales,
             coalesce(k.k_rev, 0) as revenue,
             coalesce(k.k_sales, 0) as k_sales,
             coalesce(m.m_sales, 0) as m_sales
      from k full outer join m on k.stage_id = m.stage_id
    )
    select coalesce(sum(sales), 0)::int as sales,
           coalesce(sum(revenue), 0)::numeric(12,4)::text as revenue,
           -- The part of sales the manual tally contributed. sales is
           -- greatest(manual, keitaro) per stage, so this is the excess of the
           -- manual figure over the tracker's, summed — and it is exactly the gap
           -- between Sum(is_purchase) n and sales. No second pass: per_stage
           -- already carries both sides.
           -- (NO BACKTICKS ANYWHERE IN THIS TEMPLATE: one inside a sql-tagged
           --  template literal TERMINATES it, and the file then fails to parse.)
           coalesce(sum(greatest(m_sales - k_sales, 0)), 0)::int as manual_topup,
           (select coalesce(
                     jsonb_object_agg(event_key, jsonb_build_object(
                       'n', n, 'revenue', revenue, 'pending_revenue', pending_revenue)),
                     '{}'::jsonb)
              from ev) as events,
           (select n from um) as unmapped
    from per_stage
  `)) as unknown as {
    sales: number;
    revenue: string;
    manual_topup: number;
    events: unknown;
    unmapped: number;
  }[];
  const row = rows[0];
  if (!row) return { sales: 0, revenue: "0", events: {}, unmapped: 0, manual_topup: 0 };
  return {
    sales: Number(row.sales) || 0,
    revenue: row.revenue ?? "0",
    events: parseReportEventMap(row.events),
    unmapped: Number(row.unmapped) || 0,
    manual_topup: Number(row.manual_topup) || 0,
  };
}

/**
 * Coerce the `events` jsonb into a ReportEventMap. NEVER THROWS — a NULL, a
 * hand-edited scalar and a non-object entry all become an empty map or a
 * skipped key, for the same reason parseEventMap() does it at the other grain
 * (lib/reporting/event-columns.ts): this value backs a report whose failure is
 * permanent, so a malformed row must read as missing, not as an exception.
 *
 * Both number and numeric-string inputs are accepted and both occur: postgres-js
 * JSON.parses a jsonb column so jsonb_build_object's numerics come back as JS
 * numbers, while a hand-written fixture or a text extraction yields strings.
 */
function parseReportEventMap(v: unknown): ReportEventMap {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return {};
  const num = (x: unknown): number => {
    const n = typeof x === "number" ? x : Number(x);
    return Number.isFinite(n) ? n : 0;
  };
  const out: ReportEventMap = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (raw == null || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown>;
    out[k] = {
      n: num(t.n),
      revenue: num(t.revenue),
      pending_revenue: num(t.pending_revenue),
    };
  }
  return out;
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

// Manual sales per stage over the stage's WHOLE life (no date window) — the
// send-date cohort basis of the performance report, where every sale a cohort
// stage ever earned counts.
export async function lifetimeManualSalesByStage(args: {
  orgId: string;
  stageIds: number[];
}): Promise<Map<number, number>> {
  if (args.stageIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    select sms.stage_id, sum(sms.delta)::int as m_sales
    from stage_manual_sales sms
    where sms.org_id = ${args.orgId}::uuid
      and sms.stage_id in (${sql.join(
        args.stageIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    group by sms.stage_id
  `)) as unknown as { stage_id: number; m_sales: number }[];
  return new Map(rows.map((row) => [row.stage_id, row.m_sales]));
}
