import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { salesRevenueTotals } from "@/lib/reporting/attribution";
import {
  loadEventTypes,
  visibleEventTypesByCount,
  type EventCountMap,
  type ReportEventMap,
} from "@/lib/reporting/event-columns";

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
  // ── Phase 5 ──────────────────────────────────────────────────────────────
  // Per-event-type totals, keyed by event_types.key and summed ACROSS ORGS —
  // this report has no session and covers the whole business, which is why the
  // key and not the id is the identity (event_types.id is a global serial; the
  // natural key is (org_id, key)).
  events: ReportEventMap;
  // The registry, merged across orgs, in the order the lines are printed.
  // Carried rather than re-queried in the formatter so the formatter stays PURE
  // and its tests need no database.
  eventTypes: { key: string; label: string }[];
  // Conversions in the window that matched no mapping. They are in NO other
  // field here — not in sales, not in revenue, not in `events`.
  unmapped: number;
  // How much of `sales` came from the manual tally rather than the tracker. The
  // per-event lines count tracker events only, so without this line the report
  // would disagree with itself whenever an operator hand-enters a sale.
  manualTopup: number;
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
// window. Archived stages excluded — matches salesRevenueTotals. Exported so the
// hourly Telegram report can fetch yesterday's spend alone (one query) instead
// of a full second computeReportMetrics — see app/api/cron/telegram-report.
export async function spendInRange(range: EtDayRange): Promise<number> {
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
//
// ⭐ THE SPLIT ACCUMULATES IN THE SAME LOOP, keyed by event_types.key. The key
// is the identity across orgs, not the id: event_types.id is a global serial
// while the natural key is (org_id, key) (event_types_org_key_uniq, migration
// 0181), so two orgs' "purchase" rows are the SAME line of this report and two
// orgs' id 7 and id 12 may well be it.
async function salesRevenueAllOrgs(range: EtDayRange): Promise<{
  sales: number;
  revenue: number;
  events: ReportEventMap;
  unmapped: number;
  manualTopup: number;
}> {
  const orgRows = (await db.execute(sql`
    select id::text as id from organizations
  `)) as unknown as { id: string }[];

  let sales = 0;
  let revenue = 0;
  let unmapped = 0;
  let manualTopup = 0;
  const events: ReportEventMap = {};
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
    unmapped += t.unmapped;
    manualTopup += t.manual_topup;
    for (const [key, tally] of Object.entries(t.events)) {
      // A FRESH accumulator per key, never the incoming object: mutating what
      // salesRevenueTotals returned would be fine today (nothing else holds it)
      // and is the exact aliasing bug EMPTY_TALLY's freeze exists to stop.
      const acc = (events[key] ??= { n: 0, revenue: 0, pending_revenue: 0 });
      acc.n += tally.n;
      acc.revenue += tally.revenue;
      acc.pending_revenue += tally.pending_revenue;
    }
  }
  return { sales, revenue, events, unmapped, manualTopup };
}

export async function computeReportMetrics(
  range: EtDayRange,
): Promise<ReportMetrics> {
  const [totals, spend, optOuts, delivered, registry] = await Promise.all([
    salesRevenueAllOrgs(range),
    spendInRange(range),
    optOutsInRange(range),
    deliveredInRange(range),
    // ⭐ orgId = null — the deliberate CROSS-ORG registry read. This report has
    // no session (see the header), so it is the one caller loadEventTypes'
    // null branch exists for: merged by key, lowest display_order winning the
    // label, flags OR-ed, archived only when EVERY org archived it.
    loadEventTypes(db, null),
  ]);

  const { sales, revenue, events, unmapped, manualTopup } = totals;

  return {
    sales,
    revenue,
    spend,
    optOuts,
    delivered,
    roiPct: spend > 0 ? ((revenue - spend) / spend) * 100 : null,
    events,
    // ⭐ WHICH TYPES GET A LINE IS THE SAME QUESTION THE COLUMNS ASK, so it gets
    // the same answer rather than a second one: an ACTIVE type always prints,
    // even at zero (a configured event type reading 0 at 22:00 is information;
    // vanishing is not), while an ARCHIVED type prints only while this window
    // still holds a non-zero number for it. Without this a retired type would
    // read "Old thing: 0" in the owner's report every hour for ever, and would
    // spend one of the six lines doing it.
    eventTypes: visibleEventTypesByCount(
      registry,
      [collapseToCounts(events)],
    ).map((t) => ({ key: t.key, label: t.label })),
    unmapped,
    manualTopup,
  };
}

// "Is this key live in this window" — any of the three figures non-zero. The
// shape visibleEventTypesByCount() takes; collapsing is exact, because that is
// the only question it asks.
function collapseToCounts(events: ReportEventMap): EventCountMap {
  const out: EventCountMap = {};
  for (const [k, t] of Object.entries(events)) {
    out[k] = t.n || t.revenue || t.pending_revenue;
  }
  return out;
}
