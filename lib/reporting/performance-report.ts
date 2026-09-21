import { sql, type SQL } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";

import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";

import { db } from "@/db/client";
import {
  DIMENSION_NONE_KEY,
  denominatorFor,
  getCountedClickersByCreativeOffer,
  getCountedClickersByDimension,
  getTotalCountedClickers,
  type CountedClickerBounds,
  type ReportDimensionKey,
} from "@/lib/reporting/counted-clickers";
import {
  addNullable,
  gradingRates,
  type GradingRates,
} from "@/lib/reporting/grading-rates";
import { sendDaysOf } from "@/lib/reporting/creative-rows";
import {
  addEventMaps,
  scaleEventMap,
  type EventMap,
} from "@/lib/reporting/event-columns";
import type { AttributionBasis, PerformanceDimension } from "@/lib/reporting/report-dimensions";
import {
  approvedRevenueClause,
  countedClause,
  pendingRevenueClause,
  purchasedClause,
} from "@/lib/sale-attribution";
import {
  getStageMetricsInRange,
  type ClickerDenominators,
  type StageMetrics,
} from "@/lib/reporting/stage-funnel";

// Read layer for the performance reports. All dimensions except "hourly" source
// from the SHARED per-stage funnel (lib/reporting/stage-funnel.ts) — the exact
// same numbers as the Overview tab — so By Number / By Offer / By Sequence match
// Overview to the cent, and By Group distributes those same stage totals across
// contact groups. "hourly" is different: it buckets by USER-ACTIVITY time from the
// internal per-event tables (clicks.clicked_at, conversion_events.occurred_at,
// stage_sends.offer_reached_at, opt_out_attributions.created_at). See
// docs/04-features/reports-rollup.md.
//
// Hourly sales/revenue moved from stage_sends.converted_at (Keitaro's latest
// re-post time, which MOVES) to the ledger's occurred_at (the conversion's own
// time, which never does) — see ledgerHourQuery for what that changes.

export type { ReportDimension } from "@/lib/reporting/report-dimensions";

// Raw counters returned to the client; EPC / profit / percentages derived at read
// time in the UI with Overview's formulas (redirect_rate = redirects/clickers,
// sales_cr = sales/redirects, epc = revenue/redirects, opt_out_rate/CR = /sent).
export interface PerfMetrics {
  sent: number;
  opt_outs: number;
  clickers: number;
  redirects: number;
  // Per-recipient offer reach (stage_sends.offer_reached_at). null only when
  // every stage in the row is manual-mode (see addNullable). Operator-API
  // grading input.
  reached: number | null;
  // The EPC denominator — counted clickers (lib/reporting/counted-clickers.ts),
  // the same source every other surface divides by. `clickers` above is the
  // Keitaro landing-visit count and is display-only; `redirects` is no longer a
  // denominator anywhere.
  counted_clickers: number;
  // LIFETIME pair — ignores the date filter entirely, and is the PRIMARY figure.
  // Not derivable from the period pair: counted clickers are deduplicated and
  // therefore not additive over time, so a lifetime figure can never be summed
  // out of period slices. Both are carried so each EPC can be shown next to the
  // count it actually divided by — a $0.00 EPC is only interpretable when you
  // can see the denominator was 4.
  lifetime_clickers: number;
  lifetime_revenue: number;
  sales: number;
  revenue: number;
  // The per-event-type breakdown of sales / revenue / pending_revenue, keyed by
  // event_types.key (migration 0185). ADDITIVE: no field above changes meaning.
  // The report's columns are generated from this map plus the registry
  // (lib/reporting/event-columns.ts) — nothing branches on a key.
  events: EventMap;
  // Conversions in scope that matched no mapping. In NO other field here.
  unmapped: number;
  // The part of `sales` that came from the manual tally, not the tracker, so
  // Σ (is_purchase events).n + manual_topup = sales exactly.
  manual_topup: number;
  pending_revenue: number;
  cost: number;
}

export interface PerfRow extends PerfMetrics {
  key: string;
  label: string;
  // number dimension:
  phone_number?: string | null;
  number_type?: string | null;
  provider_name?: string | null;
  provider_color?: string | null;
  account_label?: string | null;
  // group dimension:
  group_color?: string | null;
  // hourly: a pinned "Manual" row sorts first.
  pinned?: boolean;
  // creative dimension:
  creative_id?: number | null;
  offer_id?: number | null;
  first_sent_date?: string | null;
  last_sent_date?: string | null;
  distinct_send_days?: number;
}

export interface ProviderOption {
  provider_phone_id: number;
  phone_number: string | null;
  number_type: string | null;
  provider_name: string | null;
  provider_color: string | null;
  account_label: string | null;
}

export interface PerformanceReport {
  dimension: PerformanceDimension;
  rows: PerfRow[];
  totals: PerfMetrics;
  refreshedAt: string | null;
}

export const ZERO: PerfMetrics = {
  sent: 0,
  opt_outs: 0,
  clickers: 0,
  redirects: 0,
  // null, not 0: it is addNullable's identity. Starting an accumulator at 0 would
  // turn a row made only of manual-mode stages into a real-looking 0.
  reached: null,
  counted_clickers: 0,
  lifetime_clickers: 0,
  lifetime_revenue: 0,
  sales: 0,
  revenue: 0,
  // A FRESH object per accumulator — see zeroMetrics() and the freeze below.
  events: {},
  unmapped: 0,
  manual_topup: 0,
  pending_revenue: 0,
  cost: 0,
};

// ⭐ FROZEN, AND THE FREEZE IS THE GUARD, NOT THE COMMENT. `ZERO` is spread
// (`{ ...ZERO }`) by every accumulator in this module, and a spread is SHALLOW:
// without this, one forgotten `zeroMetrics()` gives two requests the same
// `events` object, addEventMaps mutates it in place, and one org's breakdown
// leaks into another's response. It is also handed out directly —
// `app/api/reports/performance/route.ts:141` does
// `stored.basis.offer_totals[String(offerId)] ?? ZERO` straight into a response
// body. Freezing turns that whole class of mistake into a TypeError in strict
// mode (all ES modules are strict) instead of silent cross-request corruption.
Object.freeze(ZERO.events);

/** A fresh zero accumulator. Use this, not `{ ...ZERO }`, wherever the result is mutated. */
export const zeroMetrics = (): PerfMetrics => ({ ...ZERO, events: {} });

function stageMetrics(
  s: StageMetrics,
  countedByStage: Map<number, number>,
  lifetimeByStage: Map<number, number>,
  lifetimeRevenueByStage: Map<number, number>,
): PerfMetrics {
  return {
    sent: s.total_sent,
    opt_outs: s.opt_outs,
    clickers: s.tally.visit_clicks_clean,
    redirects: s.tally.redirect_clicks_clean,
    reached: s.reached,
    counted_clickers: denominatorFor(
      s.link_mode,
      countedByStage.get(s.stage_id),
      s.tally.visit_clicks_clean,
    ),
    lifetime_clickers: denominatorFor(
      s.link_mode,
      lifetimeByStage.get(s.stage_id),
      s.tally.visit_clicks_clean,
    ),
    lifetime_revenue: lifetimeRevenueByStage.get(s.stage_id) ?? 0,
    sales: s.tally.sales,
    revenue: s.tally.revenue,
    // The map is COPIED, not aliased: the caller's accumulators mutate what they
    // are given, and s.tally.events belongs to the StageMetrics record, which a
    // second dimension in the same getStageDimensionReports() call also reads.
    events: addEventMaps({}, s.tally.events),
    unmapped: s.tally.unmapped,
    manual_topup: s.tally.manual_topup,
    pending_revenue: s.tally.pending_revenue,
    cost: s.tally.cost,
  };
}

/** Exported for scripts/test-event-tally-merge.ts — the five accumulators must all carry every field. */
export function addMetrics(a: PerfMetrics, b: PerfMetrics): PerfMetrics {
  return {
    sent: a.sent + b.sent,
    opt_outs: a.opt_outs + b.opt_outs,
    clickers: a.clickers + b.clickers,
    redirects: a.redirects + b.redirects,
    reached: addNullable(a.reached, b.reached),
    counted_clickers: a.counted_clickers + b.counted_clickers,
    lifetime_clickers: a.lifetime_clickers + b.lifetime_clickers,
    lifetime_revenue: a.lifetime_revenue + b.lifetime_revenue,
    sales: a.sales + b.sales,
    revenue: a.revenue + b.revenue,
    events: addEventMaps(addEventMaps({}, a.events), b.events),
    unmapped: a.unmapped + b.unmapped,
    manual_topup: a.manual_topup + b.manual_topup,
    pending_revenue: a.pending_revenue + b.pending_revenue,
    cost: a.cost + b.cost,
  };
}
/** Exported for scripts/test-event-tally-merge.ts — the five accumulators must all carry every field. */
export function scaleMetrics(m: PerfMetrics, f: number): PerfMetrics {
  return {
    sent: m.sent * f,
    opt_outs: m.opt_outs * f,
    clickers: m.clickers * f,
    redirects: m.redirects * f,
    reached: m.reached == null ? null : m.reached * f,
    counted_clickers: m.counted_clickers * f,
    lifetime_clickers: m.lifetime_clickers * f,
    lifetime_revenue: m.lifetime_revenue * f,
    sales: m.sales * f,
    revenue: m.revenue * f,
    events: scaleEventMap(m.events, f),
    unmapped: m.unmapped * f,
    manual_topup: m.manual_topup * f,
    pending_revenue: m.pending_revenue * f,
    cost: m.cost * f,
  };
}
const round2 = (n: number) => Math.round(n * 100) / 100;
const roundEventMap = (m: EventMap): EventMap =>
  Object.fromEntries(
    Object.entries(m).map(([k, t]) => [
      k,
      {
        n: round2(t.n),
        pending_n: round2(t.pending_n),
        revenue: round2(t.revenue),
        pending_revenue: round2(t.pending_revenue),
      },
    ]),
  );

// Build a parameterized IN-list from a JS number array (drizzle spreads a bare
// array, which ANY() rejects). Returns "$1, $2, ...".
function inList(ids: number[]) {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

interface Bounds {
  from: string; // ET day
  to: string; // ET day
  providerPhoneId: number | null;
  // Only this offer's stages (dimension=creative with offer_id).
  offerId?: number | null;
  // Omitted = conversion_date (every metric on its own event day). send_date = the
  // cohort of stages sent in range. Hourly always buckets by event time.
  attribution?: AttributionBasis;
}

// ET day range → [fromUtc, toExclusiveUtc), identical to stage-funnel's window.
function etRangeUtc(b: Bounds): { fromUtc: Date; toExclusiveUtc: Date } {
  const nextDay = new Date(Date.parse(`${b.to}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    fromUtc: fromZonedTime(`${b.from}T00:00:00`, CAMPAIGN_TIMEZONE),
    toExclusiveUtc: fromZonedTime(`${nextDay}T00:00:00`, CAMPAIGN_TIMEZONE),
  };
}

// The PERIOD clicker scope for this basis: the ET date range (conversion_date), or
// exactly the report's own stages with no date bound (the send_date cohort).
function periodBounds(b: Bounds, stages: StageMetrics[]): CountedClickerBounds {
  return b.attribution === "send_date"
    ? { stageIds: stages.map((s) => s.stage_id) }
    : etRangeUtc(b);
}

export type GradedPerfMetrics<T extends PerfMetrics = PerfMetrics> = T &
  GradingRates & { clicks_human: number };

// The operator-API grading fields for one row or the totals. `clicks_human` IS
// the row's counted clickers (the EPC denominator) under the name every
// operator-API surface uses; conversions are the row's tracker `sales`.
export function gradePerf<T extends PerfMetrics>(m: T): GradedPerfMetrics<T> {
  return {
    ...m,
    clicks_human: m.counted_clickers,
    ...gradingRates({
      sent: m.sent,
      opt_outs: m.opt_outs,
      clicks_human: m.counted_clickers,
      reached: m.reached,
      conversions: m.sales,
    }),
  };
}

export type StageDimension = Exclude<PerformanceDimension, "hourly">;

export async function getPerformanceReport(
  orgId: string,
  dimension: PerformanceDimension,
  b: Bounds,
): Promise<PerformanceReport> {
  if (dimension === "hourly") return getHourlyReport(orgId, b);
  const [report] = await getStageDimensionReports(orgId, [dimension], b);
  return report;
}

// Several groupings of ONE stage-metrics pass — the funnel is the expensive part
// (~13s for all time), so the lifetime job builds creative rows and per-offer
// totals from a single pass instead of two.
export async function getStageDimensionReports(
  orgId: string,
  dimensions: StageDimension[],
  b: Bounds,
): Promise<PerformanceReport[]> {
  const { stages, clickers } = await getStageMetricsInRange(orgId, b.from, b.to, {
    attribution: b.attribution,
  });
  const countedByStage = clickers.periodByStage;
  const lifeByStage = clickers.lifetimeByStage;
  const lifeRevByStage = clickers.lifetimeRevenueByStage;
  const metricsOf = (s: StageMetrics) =>
    stageMetrics(s, countedByStage, lifeByStage, lifeRevByStage);
  const filtered = stages.filter(
    (s) =>
      (b.providerPhoneId == null || s.provider_phone_id === b.providerPhoneId) &&
      (b.offerId == null || s.offer_id === b.offerId),
  );

  const totals = filtered.reduce((acc, s) => addMetrics(acc, metricsOf(s)), zeroMetrics());
  await dedupeTotalClickers(orgId, b, filtered, totals, clickers);
  const refreshedAt = await maxSyncedAt(orgId);

  return Promise.all(
    dimensions.map(async (dimension): Promise<PerformanceReport> => {
      let rows: PerfRow[];
      if (dimension === "group") {
        // BY-GROUP IS EXEMPT from dimension-grain deduplication, by construction.
        // Its metrics are FRACTIONALLY SPLIT across a contact's groups (a contact in
        // 3 used groups contributes ⅓ to each), and a fractional share cannot be
        // deduplicated — there is no set to take a DISTINCT over. Its clicker counts
        // therefore remain split sums and are NOT comparable with the other tabs.
        // Labelled as such in the UI. See docs/04-features/epc-denominator.md.
        rows = await distributeToGroups(orgId, filtered, b, metricsOf);
      } else if (dimension === "creative") {
        rows = await groupByCreativeOffer(orgId, filtered, b, metricsOf);
      } else {
        rows = await groupByStageDimension(filtered, dimension, metricsOf);
        // Replace the summed clicker counts with DISTINCT counts at the dimension's
        // own grain — the row grain the rule refers to. Revenue stays summed; it is
        // genuinely additive.
        await applyDimensionDistinctClickers(orgId, dimension, b, rows, filtered);
      }
      return { dimension, rows, totals, refreshedAt };
    }),
  );
}

// The totals row dedupes clickers at REPORT grain — distinct (campaign,
// contact), the Overview totals-card definition — instead of summing per-stage
// counts, which double-counts anyone who clicked two stages. Manual stages add
// their Keitaro visits (an aggregate with no set to dedup), same as dimension rows.
async function dedupeTotalClickers(
  orgId: string,
  b: Bounds,
  stages: StageMetrics[],
  totals: PerfMetrics,
  clickers: ClickerDenominators,
): Promise<void> {
  const manualVisits = stages
    .filter((s) => s.link_mode !== "tracked")
    .reduce((a, s) => a + s.tally.visit_clicks_clean, 0);
  if (b.offerId != null) {
    // One offer's totals = that offer's row in dimension=offer: distinct clickers
    // at the offer grain, over the same period scope.
    const [period, lifetime] = await Promise.all([
      getCountedClickersByDimension(db, orgId, "offer", periodBounds(b, stages)),
      getCountedClickersByDimension(db, orgId, "offer"),
    ]);
    totals.counted_clickers = (period.get(b.offerId) ?? 0) + manualVisits;
    totals.lifetime_clickers = (lifetime.get(b.offerId) ?? 0) + manualVisits;
    return;
  }
  if (b.providerPhoneId == null) {
    totals.counted_clickers = clickers.periodTotal + manualVisits;
    totals.lifetime_clickers = clickers.lifetimeTotal + manualVisits;
    return;
  }
  const opts = { providerPhoneId: b.providerPhoneId };
  const [period, lifetime] = await Promise.all([
    // send_date: the cohort stages are already number-filtered, so scope by them.
    b.attribution === "send_date"
      ? getTotalCountedClickers(db, orgId, periodBounds(b, stages))
      : getTotalCountedClickers(db, orgId, etRangeUtc(b), opts),
    getTotalCountedClickers(db, orgId, {}, opts),
  ]);
  totals.counted_clickers = period + manualVisits;
  totals.lifetime_clickers = lifetime + manualVisits;
}

// ---- number / offer / sequence: group the shared stage metrics -------------
async function groupByStageDimension(
  stages: StageMetrics[],
  dimension: "number" | "offer" | "sequence",
  metricsOf: (s: StageMetrics) => PerfMetrics,
): Promise<PerfRow[]> {
  const keyOf = (s: StageMetrics): string => {
    if (dimension === "number") return s.provider_phone_id == null ? "none" : String(s.provider_phone_id);
    if (dimension === "offer") return s.offer_id == null ? "none" : String(s.offer_id);
    return s.stage_number == null ? "none" : String(s.stage_number);
  };
  const acc = new Map<string, PerfMetrics>();
  for (const s of stages) {
    const k = keyOf(s);
    acc.set(k, addMetrics(acc.get(k) ?? zeroMetrics(), metricsOf(s)));
  }

  if (dimension === "number") {
    const ids = [...acc.keys()].filter((k) => k !== "none").map(Number);
    const info = await providerInfo(ids);
    return [...acc.entries()]
      .map(([k, m]) => {
        const pi = k === "none" ? null : info.get(Number(k));
        return {
          key: k,
          label: pi?.phone_number ?? "No number",
          phone_number: pi?.phone_number ?? null,
          number_type: pi?.number_type ?? null,
          provider_name: pi?.provider_name ?? null,
          provider_color: pi?.provider_color ?? null,
          account_label: pi?.account_label ?? null,
          ...m,
        };
      })
      .sort((a, b) => b.sent - a.sent);
  }
  if (dimension === "offer") {
    const ids = [...acc.keys()].filter((k) => k !== "none").map(Number);
    const info = await offerInfo(ids);
    return [...acc.entries()]
      .map(([k, m]) => {
        const oi = k === "none" ? null : info.get(Number(k));
        return {
          key: k,
          label: oi ? (oi.name ? `${oi.name} (${oi.code})` : oi.code) : "No offer",
          ...m,
        };
      })
      .sort((a, b) => b.sent - a.sent);
  }
  // sequence
  return [...acc.entries()]
    .map(([k, m]) => ({ key: k, label: k === "none" ? "—" : `Message ${k}`, ...m }))
    .sort((a, b) => (Number(a.key) || 0) - (Number(b.key) || 0));
}

// Overwrite the summed clicker counts on already-grouped rows with DISTINCT
// counts at the dimension's grain.
//
// MANUAL-MODE STAGES need care: they mint no links, so they have no
// counted_clickers rows and their denominator is Keitaro's clean landing-visit
// counter. Visits are an aggregate, not a set, so they cannot join a DISTINCT.
// The dimension total is therefore:
//     DISTINCT(tracked contacts in the dimension)  +  SUM(manual stages' visits)
// which is the exact aggregate form of the per-stage denominatorFor() rule.
async function applyDimensionDistinctClickers(
  orgId: string,
  dimension: "number" | "offer" | "sequence",
  b: Bounds,
  rows: PerfRow[],
  stages: StageMetrics[],
): Promise<void> {
  // Same ET-range → UTC conversion stage-funnel uses, so the period window here
  // is byte-identical to the one the funnel metrics were computed over.
  // Under send_date the period scope is the cohort's own stages, not a window.
  const [period, lifetime] = await Promise.all([
    getCountedClickersByDimension(
      db,
      orgId,
      dimension as ReportDimensionKey,
      periodBounds(b, stages),
    ),
    getCountedClickersByDimension(db, orgId, dimension as ReportDimensionKey),
  ]);

  // Manual-mode visit counts per dimension key, summed (they cannot be deduped).
  const manualVisits = new Map<string, number>();
  const keyOf = (s: StageMetrics): string => {
    if (dimension === "number") return s.provider_phone_id == null ? "none" : String(s.provider_phone_id);
    if (dimension === "offer") return s.offer_id == null ? "none" : String(s.offer_id);
    return s.stage_number == null ? "none" : String(s.stage_number);
  };
  for (const s of stages) {
    if (s.link_mode === "tracked") continue;
    const k = keyOf(s);
    manualVisits.set(k, (manualVisits.get(k) ?? 0) + s.tally.visit_clicks_clean);
  }

  for (const row of rows) {
    const dimKey = row.key === "none" ? DIMENSION_NONE_KEY : Number(row.key);
    const manual = manualVisits.get(row.key) ?? 0;
    row.counted_clickers = (period.get(dimKey) ?? 0) + manual;
    row.lifetime_clickers = (lifetime.get(dimKey) ?? 0) + manual;
  }
}

// ---- creative: one row per creative × offer --------------------------------
// Additive metrics summed over the row's stages; clickers DISTINCT at creative ×
// offer grain plus manual-mode visits (the denominatorFor rule, aggregated). The
// send-day fields cover the row's stages SENT inside the range — for lifetime the
// range starts at the first send, so that is every stage.
async function groupByCreativeOffer(
  orgId: string,
  stages: StageMetrics[],
  b: Bounds,
  metricsOf: (s: StageMetrics) => PerfMetrics,
): Promise<PerfRow[]> {
  const { fromUtc, toExclusiveUtc } = etRangeUtc(b);
  const acc = new Map<
    string,
    { m: PerfMetrics; creativeId: number | null; offerId: number | null; days: string[]; manualVisits: number }
  >();
  for (const s of stages) {
    const key = `${s.creative_id ?? DIMENSION_NONE_KEY}:${s.offer_id ?? DIMENSION_NONE_KEY}`;
    const e = acc.get(key) ?? {
      m: zeroMetrics(),
      creativeId: s.creative_id,
      offerId: s.offer_id,
      days: [],
      manualVisits: 0,
    };
    e.m = addMetrics(e.m, metricsOf(s));
    if (s.sent_at && s.sent_at >= fromUtc && s.sent_at < toExclusiveUtc) {
      e.days.push(formatInCampaignTimezone(s.sent_at, "yyyy-MM-dd"));
    }
    if (s.link_mode !== "tracked") e.manualVisits += s.tally.visit_clicks_clean;
    acc.set(key, e);
  }

  const entries = [...acc.entries()];
  const [period, lifetime, slugs, offers] = await Promise.all([
    getCountedClickersByCreativeOffer(db, orgId, periodBounds(b, stages)),
    getCountedClickersByCreativeOffer(db, orgId),
    creativeSlugs(
      orgId,
      entries.map(([, e]) => e.creativeId).filter((id): id is number => id != null),
    ),
    offerInfo(entries.map(([, e]) => e.offerId).filter((id): id is number => id != null)),
  ]);

  return entries.map(([key, e]) => {
    const slug = e.creativeId == null ? "No creative" : slugs.get(e.creativeId) ?? `#${e.creativeId}`;
    const oi = e.offerId == null ? null : offers.get(e.offerId);
    return {
      key,
      label: `${slug} — ${oi ? oi.name || oi.code : "No offer"}`,
      creative_id: e.creativeId,
      offer_id: e.offerId,
      ...e.m,
      counted_clickers: (period.get(key) ?? 0) + e.manualVisits,
      lifetime_clickers: (lifetime.get(key) ?? 0) + e.manualVisits,
      ...sendDaysOf(e.days),
    };
  });
}

// ---- group: distribute each stage's totals across its used contact groups ---
// Tracked campaigns: per-metric weights from per-contact events (each event ⅟k
// across the contact's groups that were USED in the campaign audience). Manual
// campaigns: weights from each used group's audience-allocation count. Shares sum
// to 1 per stage, so per-metric group totals reconcile to the stage total (and
// thus to Overview). Values rounded to 2 decimals.
async function distributeToGroups(
  orgId: string,
  stages: StageMetrics[],
  b: Bounds,
  metricsOf: (s: StageMetrics) => PerfMetrics,
): Promise<PerfRow[]> {
  const trackedIds = stages.filter((s) => s.link_mode === "tracked").map((s) => s.stage_id);
  const manualStages = stages.filter((s) => s.link_mode !== "tracked");
  const manualCampaignIds = [...new Set(manualStages.map((s) => s.campaign_id))];

  // Per-(stage, group) weights for tracked stages, one map per metric basis.
  const [wSent, wClick, wSale, wOpt] = await Promise.all([
    trackedWeights(orgId, trackedIds, b, "sent"),
    trackedWeights(orgId, trackedIds, b, "click"),
    trackedWeights(orgId, trackedIds, b, "sale"),
    trackedWeights(orgId, trackedIds, b, "optout"),
  ]);
  // Reach weights run AFTER that batch, deliberately not inside it. The click
  // query above walks every scored-human click (~50s at any range, measured
  // 2026-09-14) and already brushes the 2-minute statement timeout when its
  // siblings contend with it; a fifth concurrent query would push it over more
  // often. Sequenced here it costs ~4s of wall time and adds no contention.
  const wReach = await trackedWeights(orgId, trackedIds, b, "reach");
  // Per-(campaign, group) allocation weights for manual campaigns.
  const manualAlloc = await manualAllocationWeights(orgId, manualCampaignIds);
  // Campaign → used contact groups, for the last-resort equal split that
  // guarantees no metric is dropped (every campaign has ≥1 used group).
  const usedGroups = await usedGroupsByCampaign(orgId, [
    ...new Set(stages.map((s) => s.campaign_id)),
  ]);

  const byGroup = new Map<number, PerfMetrics>();
  const add = (gid: number, m: PerfMetrics) =>
    byGroup.set(gid, addMetrics(byGroup.get(gid) ?? zeroMetrics(), m));

  for (const s of stages) {
    const m = metricsOf(s);
    // Final fallback: equal split across the campaign's used groups.
    const equalW = new Map((usedGroups.get(s.campaign_id) ?? []).map((g) => [g, 1]));
    if (s.link_mode === "tracked") {
      // Each metric by its own per-contact weights → sent weights → equal split,
      // so a metric is never lost when its finer signal is missing for a stage.
      const sentW = nonEmpty(wSent.get(s.stage_id)) ?? equalW;
      spread(add, m.sent, sentW, "sent");
      spread(add, m.opt_outs, nonEmpty(wOpt.get(s.stage_id)) ?? sentW, "opt_outs");
      spread(add, m.clickers, nonEmpty(wClick.get(s.stage_id)) ?? sentW, "clickers");
      // Counted clickers distribute on the CLICK weights — same basis as the
      // metric they denominate. The LIFETIME pair gets the same treatment on the
      // same bases (clickers on click weights, revenue on sale weights), so a
      // group's lifetime EPC is built from consistently-split parts rather than
      // mixing a split numerator with an unsplit denominator.
      spread(add, m.counted_clickers, nonEmpty(wClick.get(s.stage_id)) ?? sentW, "counted_clickers");
      spread(add, m.lifetime_clickers, nonEmpty(wClick.get(s.stage_id)) ?? sentW, "lifetime_clickers");
      spread(add, m.lifetime_revenue, nonEmpty(wSale.get(s.stage_id)) ?? sentW, "lifetime_revenue");
      spread(add, m.redirects, nonEmpty(wClick.get(s.stage_id)) ?? sentW, "redirects");
      // Reach splits on who REACHED (per-contact reach weights), like sales on
      // who converted. Only tracked stages carry a reach to split.
      if (m.reached != null) {
        spread(add, m.reached, nonEmpty(wReach.get(s.stage_id)) ?? sentW, "reached");
      }
      // ⚠️ THE `?? sentW` FALLBACK RE-ATTRIBUTES, IT DOES NOT ZERO. When a stage
      // has NO sale weights — no ledger purchase resolved to one of its
      // recipients, which is now also the case for a stage whose only conversions
      // are rejected or unmapped — the stage's sales and revenue are spread
      // across its groups on SENT weights instead. The stage total still
      // reconciles (that is what the fallback is for: no metric is ever dropped),
      // but the per-group split is then "who was messaged", not "who bought", and
      // the row cannot tell you which. Only By Group is affected; every other
      // dimension sums the stage totals directly.
      spread(add, m.sales, nonEmpty(wSale.get(s.stage_id)) ?? sentW, "sales");
      spread(add, m.revenue, nonEmpty(wSale.get(s.stage_id)) ?? sentW, "revenue");
      spread(add, m.pending_revenue, nonEmpty(wSale.get(s.stage_id)) ?? sentW, "pending_revenue");
      // The breakdown splits on the SAME basis as the numbers it breaks down —
      // sale weights, with the documented `?? sentW` re-attribution — so a
      // group's Registrations and its Sales are built from consistent parts. It
      // cannot use spread(): that helper adds ONE number into ONE field, and this
      // is a map. The emptiness test mirrors spread()'s `if (total === 0) return`
      // — without it a stage with no conversions at all would mint an all-zero
      // row for every used group, which By Group has never done.
      if (Object.keys(m.events).length > 0) {
        for (const [gid, frac] of shares(nonEmpty(wSale.get(s.stage_id)) ?? sentW)) {
          add(gid, { ...zeroMetrics(), events: scaleEventMap(m.events, frac) });
        }
      }
      // Unmapped conversions and the manual top-up have no finer weight by
      // construction — an unmapped row resolved to no recipient, and a manual
      // tally is a stage-level number — so both split on SENT. The per-group
      // figure is therefore "share of the stage's audience", and only the page
      // total (which is what the badge and the footing bar read) is exact.
      spread(add, m.unmapped, sentW, "unmapped");
      spread(add, m.manual_topup, sentW, "manual_topup");
      spread(add, m.cost, sentW, "cost");
    } else {
      const allocW = nonEmpty(manualAlloc.get(s.campaign_id)) ?? equalW;
      for (const [gid, frac] of shares(allocW)) add(gid, scaleMetrics(m, frac));
    }
  }

  const info = await groupInfo([...byGroup.keys()]);
  return [...byGroup.entries()]
    .map(([gid, m]) => ({
      key: String(gid),
      label: info.get(gid)?.name ?? "No group",
      group_color: info.get(gid)?.color ?? null,
      sent: round2(m.sent),
      opt_outs: round2(m.opt_outs),
      clickers: round2(m.clickers),
      redirects: round2(m.redirects),
      reached: m.reached == null ? null : round2(m.reached),
      counted_clickers: round2(m.counted_clickers),
      lifetime_clickers: round2(m.lifetime_clickers),
      lifetime_revenue: round2(m.lifetime_revenue),
      sales: round2(m.sales),
      revenue: round2(m.revenue),
      events: roundEventMap(m.events),
      unmapped: round2(m.unmapped),
      manual_topup: round2(m.manual_topup),
      pending_revenue: round2(m.pending_revenue),
      cost: round2(m.cost),
    }))
    .sort((a, b) => b.sent - a.sent);
}

// Return the weight map only if it has entries, else undefined (so the caller's
// ?? fallback chain kicks in — keeps a metric from vanishing when its finer
// per-contact signal is missing for a stage).
function nonEmpty(w: Map<number, number> | undefined): Map<number, number> | undefined {
  return w && w.size > 0 ? w : undefined;
}

// Campaign → its used contact-group ids (campaigns.audience_contact_group_ids).
async function usedGroupsByCampaign(
  orgId: string,
  campaignIds: number[],
): Promise<Map<number, number[]>> {
  if (campaignIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT id, audience_contact_group_ids AS groups
    FROM campaigns WHERE org_id = ${orgId}::uuid AND id IN (${inList(campaignIds)})
  `)) as unknown as { id: number; groups: number[] | null }[];
  return new Map(rows.map((r) => [Number(r.id), (r.groups ?? []).map(Number)]));
}

// Distribute `total` across groups by the weight map's shares, adding to the acc.
function spread(
  add: (gid: number, m: PerfMetrics) => void,
  total: number,
  weights: Map<number, number>,
  field: keyof PerfMetrics,
) {
  if (total === 0) return;
  for (const [gid, frac] of shares(weights)) {
    add(gid, { ...zeroMetrics(), [field]: total * frac });
  }
}

// Normalize a weight map into fractional shares summing to 1.
function shares(weights: Map<number, number>): Map<number, number> {
  const sum = [...weights.values()].reduce((a, b) => a + b, 0);
  const out = new Map<number, number>();
  if (sum <= 0) return out;
  for (const [gid, w] of weights) out.set(gid, w / sum);
  return out;
}

type WeightBasis = "sent" | "click" | "sale" | "optout" | "reach";

// The `sale` basis's candidate (stage, contact) set: who converted, from the
// ledger. DISTINCT keeps one row per (stage, contact) so the weights stay
// per-CONTACT exactly as before (the 1/k normalisation in trackedWeights would
// cancel duplicates anyway, but an explicit DISTINCT states the intended grain).
//
// EXPORTED so scripts/test-p3-task4-reader-switch-db.ts proves THIS text rather
// than a retyped lookalike. trackedWeights itself executes against the
// module-level `db`, which cannot see a test's uncommitted fixtures, so the
// candidate set is the largest piece of it a rolled-back proof can reach; the
// 1/k spread downstream is unchanged by the ledger switch.
export function saleWeightCandidates(orgId: string, stageIds: number[]): SQL {
  return sql`
        SELECT DISTINCT ss.stage_id, ss.contact_id, cs.campaign_id
        FROM conversion_events ce
        JOIN stage_sends ss ON ss.id = ce.stage_send_id
        JOIN campaign_stages cs ON cs.id = ss.stage_id
        WHERE ce.org_id = ${orgId}::uuid
          AND ${purchasedClause()}
          AND ss.stage_id IN (${inList(stageIds)})`;
}

// Per-(stage, group) weight = Σ over the stage's qualifying contacts of 1/k,
// where k = how many of the contact's groups were USED in the campaign audience.
async function trackedWeights(
  orgId: string,
  stageIds: number[],
  b: Bounds,
  basis: WeightBasis,
): Promise<Map<number, Map<number, number>>> {
  if (stageIds.length === 0) return new Map();
  // Candidate (stage, contact) set per basis.
  const candidate =
    basis === "sent"
      ? sql`
        SELECT ss.stage_id, ss.contact_id, cs.campaign_id
        FROM stage_sends ss
        JOIN campaign_stages cs ON cs.id = ss.stage_id
        WHERE ss.org_id = ${orgId}::uuid AND ss.status = 'sent'
          AND ss.stage_id IN (${inList(stageIds)})`
      : basis === "click"
        ? sql`
        SELECT DISTINCT ss.stage_id, ss.contact_id, cs.campaign_id
        FROM stage_sends ss
        JOIN campaign_stages cs ON cs.id = ss.stage_id
        JOIN clicks ck ON ck.link_id = ss.link_id
          AND ck.classification = 'human' AND ck.scored_at IS NOT NULL
        WHERE ss.org_id = ${orgId}::uuid AND ss.stage_id IN (${inList(stageIds)})`
        : basis === "sale"
          ? saleWeightCandidates(orgId, stageIds)
          : basis === "reach"
            ? sql`
        SELECT ss.stage_id, ss.contact_id, cs.campaign_id
        FROM stage_sends ss
        JOIN campaign_stages cs ON cs.id = ss.stage_id
        WHERE ss.org_id = ${orgId}::uuid AND ss.offer_reached_at IS NOT NULL
          AND ss.stage_id IN (${inList(stageIds)})`
            : sql`
        SELECT ss.stage_id, ss.contact_id, cs.campaign_id
        FROM stage_sends ss
        JOIN campaign_stages cs ON cs.id = ss.stage_id
        JOIN opt_out_attributions oa ON oa.stage_send_id = ss.id
        WHERE ss.org_id = ${orgId}::uuid AND ss.stage_id IN (${inList(stageIds)})`;

  const rows = (await db.execute(sql`
    WITH cand AS (${candidate}),
    cgu AS (
      SELECT cand.stage_id, cand.contact_id, ccg.contact_group_id AS group_id
      FROM cand
      JOIN campaigns c ON c.id = cand.campaign_id
      JOIN contact_contact_groups ccg ON ccg.contact_id = cand.contact_id
        AND ccg.contact_group_id = ANY(c.audience_contact_group_ids)
    ),
    kc AS (
      SELECT stage_id, contact_id, count(*) AS k FROM cgu GROUP BY stage_id, contact_id
    )
    SELECT cgu.stage_id, cgu.group_id, sum(1.0 / kc.k)::float8 AS weight
    FROM cgu JOIN kc ON kc.stage_id = cgu.stage_id AND kc.contact_id = cgu.contact_id
    GROUP BY cgu.stage_id, cgu.group_id
  `)) as unknown as { stage_id: number; group_id: number; weight: number }[];

  const out = new Map<number, Map<number, number>>();
  for (const r of rows) {
    if (!out.has(r.stage_id)) out.set(r.stage_id, new Map());
    out.get(r.stage_id)!.set(Number(r.group_id), Number(r.weight));
  }
  return out;
}

// Per-(campaign, group) allocation weight = # of the campaign's frozen audience
// contacts in each used group (a shared contact counts in each of its groups).
async function manualAllocationWeights(
  orgId: string,
  campaignIds: number[],
): Promise<Map<number, Map<number, number>>> {
  if (campaignIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT cap.campaign_id, ccg.contact_group_id AS group_id, count(*)::int AS weight
    FROM campaign_audience_pool cap
    JOIN campaigns c ON c.id = cap.campaign_id
    JOIN contact_contact_groups ccg ON ccg.contact_id = cap.contact_id
      AND ccg.contact_group_id = ANY(c.audience_contact_group_ids)
    WHERE cap.org_id = ${orgId}::uuid AND cap.campaign_id IN (${inList(campaignIds)})
    GROUP BY cap.campaign_id, ccg.contact_group_id
  `)) as unknown as { campaign_id: number; group_id: number; weight: number }[];
  const out = new Map<number, Map<number, number>>();
  for (const r of rows) {
    if (!out.has(r.campaign_id)) out.set(r.campaign_id, new Map());
    out.get(r.campaign_id)!.set(Number(r.group_id), Number(r.weight));
  }
  return out;
}

// The hourly tab's ET range, shared by every query on the tab so they cannot
// disagree about what "in range" means.
// NAME IS NARROWER THAN THE USE: callers are ledgerHourQuery + getHourlyReport
// (the hourly tab) AND manualRangeRow, which is not hourly at all — it is an ET
// DATE-RANGE bound, and the manual row must use the same one as the tab it is
// pinned to.
function hourlyEtRange(from: string, to: string): { start: SQL; end: SQL } {
  return {
    start: sql`(${from} || ' 00:00')::timestamp AT TIME ZONE 'America/New_York'`,
    end: sql`((${to}::date + 1) || ' 00:00')::timestamp AT TIME ZONE 'America/New_York'`,
  };
}

// Hourly sales/revenue, straight from the ledger, bucketed by the CONVERSION's
// own ET hour. NOT the stage_sends-walking eventAgg in getHourlyReport: a send
// row could hold only ONE conversion — so a recipient's second conversion was
// invisible — and a stage-attributable conversion whose recipient never resolved
// (26 of them, $1,463) could not be counted at all. The INNER JOIN to
// campaign_stages is what scopes the rows to this org's stages and carries the
// provider filter; a ledger row with no stage cannot be placed in an hour.
//
// ⚠️ THE INSTANT IS `ce.occurred_at`, AND THAT IS A DELIBERATE CHANGE OF MEANING.
// The old basis was stage_sends.converted_at — the time of the LATEST postback
// for that recipient, which Keitaro moves when it re-posts a conversion. So a
// re-post silently carried revenue into a later hour, and out of the range
// entirely once it crossed midnight: yesterday's 9pm sale became today's 2am
// sale, and yesterday's report changed after the fact. `occurred_at` is when the
// conversion happened and never moves, so an hour, once reported, stays put.
// This is the one change in Task 4 that can move a number TODAY (correction
// class D — see the Phase 3 plan); it is not a regression.
//
// EXPORTED for scripts/test-p3-task4-reader-switch-db.ts: the hour bucketing,
// the occurred_at range and the provider filter are exactly the parts a retyped
// "simplified shape" used to drop, which left the only semantic change in the
// task untested.
export function ledgerHourQuery(args: {
  orgId: string;
  from: string;
  to: string;
  providerPhoneId?: number | null;
  where: SQL;
  valueExpr: SQL;
}): SQL {
  const { start, end } = hourlyEtRange(args.from, args.to);
  const provFilter =
    args.providerPhoneId != null
      ? sql`AND cs.provider_phone_id = ${args.providerPhoneId}`
      : sql``;
  return sql`
      SELECT EXTRACT(HOUR FROM ce.occurred_at AT TIME ZONE 'America/New_York')::int AS hour,
             ${args.valueExpr} AS v
      FROM conversion_events ce
      JOIN campaign_stages cs ON cs.id = ce.stage_id
        ${provFilter}
      WHERE ce.org_id = ${args.orgId}::uuid
        AND ce.occurred_at >= ${start} AND ce.occurred_at < ${end}
        AND ${args.where}
      GROUP BY 1
    `;
}

/**
 * The hourly tab's per-event breakdown AND its unmapped count, in one pass.
 *
 * Bucketed on ce.occurred_at exactly like ledgerHourQuery, so the split lands in
 * the same hours as the `sales` and `revenue` series it breaks down — a second
 * time basis here would make the columns of one row disagree about what "3pm"
 * means.
 *
 * `event_key` is NULL for an unmapped row (the LEFT JOIN), which is how the same
 * query answers both questions. The join carries org_id as well as the id.
 *
 * The status predicates are the same generalisation the stage-day projection
 * uses (lib/keitaro/stage-day-conversions.ts): countedClause for `n`, and
 * counts_revenue + the approved/pending literal for the money.
 *
 * ⭐ `unmapped` IS KEYED ON THE JOIN RESULT (et.key IS NULL), NOT ON THE RAW
 * COLUMN (ce.event_type_id IS NULL) — the same choice, for the same reason, as
 * the projection's own unmapped_n (lib/keitaro/stage-day-conversions.ts). The
 * scalar `sales`/`revenue` series beside this one resolve their flags through the
 * NON-org-scoped PURCHASE_EVENT_TYPE_IDS / REVENUE_EVENT_TYPE_IDS, while this
 * join is org-scoped, so a ledger row carrying ANOTHER org's event_type_id is
 * counted by the scalar and lands under no key. Keyed on et.key it is counted
 * here; keyed on the raw column it would be counted nowhere and invisible on the
 * one surface whose entire purpose is to reveal rows that count as nothing.
 */
export function ledgerHourEventQuery(args: {
  orgId: string;
  from: string;
  to: string;
  providerPhoneId?: number | null;
}): SQL {
  const { start, end } = hourlyEtRange(args.from, args.to);
  const provFilter =
    args.providerPhoneId != null
      ? sql`AND cs.provider_phone_id = ${args.providerPhoneId}`
      : sql``;
  return sql`
      SELECT EXTRACT(HOUR FROM ce.occurred_at AT TIME ZONE 'America/New_York')::int AS hour,
             et.key AS event_key,
             count(*) FILTER (WHERE ${countedClause()})::int AS n,
             count(*) FILTER (WHERE ce.status = 'pending')::int AS pending_n,
             coalesce(sum(ce.revenue) FILTER (WHERE et.counts_revenue AND ce.status = 'approved'), 0)::float8 AS revenue,
             coalesce(sum(ce.revenue) FILTER (WHERE et.counts_revenue AND ce.status = 'pending'), 0)::float8 AS pending_revenue,
             count(*) FILTER (WHERE et.key IS NULL OR ce.status IS NULL)::int AS unmapped
      FROM conversion_events ce
      JOIN campaign_stages cs ON cs.id = ce.stage_id
        ${provFilter}
      LEFT JOIN event_types et ON et.id = ce.event_type_id AND et.org_id = ce.org_id
      WHERE ce.org_id = ${args.orgId}::uuid
        AND ce.occurred_at >= ${start} AND ce.occurred_at < ${end}
      GROUP BY 1, 2
    `;
}

// ---- hourly: user-activity time from internal per-event tables --------------
async function getHourlyReport(orgId: string, b: Bounds): Promise<PerformanceReport> {
  const provFilter = b.providerPhoneId != null;
  // Tracked events across the ET date range, bucketed by the EVENT's ET hour-of-day (summed over all days in the range). The
  // provider filter (if set) restricts to sends from that number (via the stage).
  const provJoin = provFilter
    ? sql`JOIN campaign_stages cs ON cs.id = ss.stage_id AND cs.provider_phone_id = ${b.providerPhoneId}`
    : sql``;
  const { start: rangeStart, end: rangeEnd } = hourlyEtRange(b.from, b.to);
  const hourExpr = (col: string) =>
    sql`EXTRACT(HOUR FROM ${sql.raw(col)} AT TIME ZONE 'America/New_York')::int`;

  const eventAgg = async (
    tsCol: string,
    join: ReturnType<typeof sql>,
    where: ReturnType<typeof sql>,
    valueExpr: ReturnType<typeof sql>,
  ) =>
    (await db.execute(sql`
      SELECT ${hourExpr(tsCol)} AS hour, ${valueExpr} AS v
      FROM stage_sends ss ${join}
      WHERE ss.org_id = ${orgId}::uuid
        AND ${sql.raw(tsCol)} >= ${rangeStart} AND ${sql.raw(tsCol)} < ${rangeEnd}
        AND ${where}
      GROUP BY 1
    `)) as unknown as { hour: number; v: number }[];

  // Sales and revenue from the ledger, by the CONVERSION's own ET hour — the
  // query text lives in ledgerHourQuery above (exported so its proof runs the
  // real thing), including why the instant is occurred_at and not converted_at.
  const ledgerHourAgg = async (where: SQL, valueExpr: SQL) =>
    (await db.execute(
      ledgerHourQuery({
        orgId,
        from: b.from,
        to: b.to,
        providerPhoneId: b.providerPhoneId,
        where,
        valueExpr,
      }),
    )) as unknown as { hour: number; v: number }[];

  const [
    sentRows,
    clicks,
    redirects,
    sales,
    revenue,
    pendingRevenue,
    optouts,
    clickerRows,
    evRows,
  ] = await Promise.all([
    // Sent messages by SEND hour (tracked stage_sends; manual-campaign sends have
    // no per-message time and roll up into the Manual row). This is the one column
    // bucketed by send time, not activity time — it's the denominator for the rates.
    (await db.execute(sql`
      SELECT ${hourExpr("ss.sent_at")} AS hour, count(*)::int AS v
      FROM stage_sends ss ${provJoin}
      WHERE ss.org_id = ${orgId}::uuid AND ss.status = 'sent'
        AND ss.sent_at >= ${rangeStart} AND ss.sent_at < ${rangeEnd}
      GROUP BY 1
    `)) as unknown as { hour: number; v: number }[],
    // clean internal clicks by click time
    (await db.execute(sql`
      SELECT ${hourExpr("ck.clicked_at")} AS hour, count(*)::int AS v
      FROM clicks ck
      JOIN stage_sends ss ON ss.link_id = ck.link_id ${provJoin}
      WHERE ck.org_id = ${orgId}::uuid
        AND ck.classification = 'human' AND ck.scored_at IS NOT NULL
        AND ck.clicked_at >= ${rangeStart} AND ck.clicked_at < ${rangeEnd}
      GROUP BY 1
    `)) as unknown as { hour: number; v: number }[],
    eventAgg("ss.offer_reached_at", provJoin, sql`ss.offer_reached_at IS NOT NULL`, sql`count(*)::int`),
    ledgerHourAgg(purchasedClause(), sql`count(*)::int`),
    ledgerHourAgg(approvedRevenueClause(), sql`coalesce(sum(ce.revenue), 0)::float8`),
    // ⭐ HELD MONEY, COMPUTED — NOT LEFT AS A ZERO THAT MEANS "NOT COMPUTED".
    // This series is the exact counterpart of `revenue` above: the same ledger,
    // the same ce.occurred_at hour, the same shared clause family
    // (lib/sale-attribution.ts), differing only in the status literal. Pending
    // money is never added into revenue — it is a separate figure in EVERY
    // surface that carries both.
    //
    // It exists because the hourly row map used to hard-code `pending_revenue: 0`
    // while ledgerHourEventQuery computed REAL pending figures into `m.events`,
    // so one API body answered the same question twice: `totals.pending_revenue:
    // 0` beside a non-zero `events[k].pending_revenue`. A consumer could not tell
    // that 0 from a measured one, and "no column renders it" is a condition one
    // column addition away from being false. The two now agree by construction,
    // with the same cross-org residual that `revenue` has (see
    // ledgerHourEventQuery), which `unmapped` accounts for.
    ledgerHourAgg(pendingRevenueClause(), sql`coalesce(sum(ce.revenue), 0)::float8`),
    // opt-outs by receipt time, for TRACKED stages
    (await db.execute(sql`
      SELECT ${hourExpr("oa.created_at")} AS hour, count(*)::int AS v
      FROM opt_out_attributions oa
      JOIN stage_sends ss ON ss.id = oa.stage_send_id ${provJoin}
      JOIN campaign_stages cs2 ON cs2.id = ss.stage_id
      JOIN campaigns c ON c.id = cs2.campaign_id AND c.link_mode = 'tracked'
      WHERE oa.org_id = ${orgId}::uuid
        AND oa.created_at >= ${rangeStart} AND oa.created_at < ${rangeEnd}
      GROUP BY 1
    `)) as unknown as { hour: number; v: number }[],
    // Distinct counted clickers (the EPC denominator) by FIRST-click ET hour.
    (await db.execute(sql`
      SELECT ${hourExpr("cc.first_click_at")} AS hour, count(DISTINCT cc.contact_id)::int AS v
      FROM counted_clickers cc
      ${provFilter ? sql`JOIN campaign_stages cs ON cs.id = cc.stage_id AND cs.provider_phone_id = ${b.providerPhoneId}` : sql``}
      WHERE cc.org_id = ${orgId}::uuid
        AND cc.first_click_at >= ${rangeStart} AND cc.first_click_at < ${rangeEnd}
      GROUP BY 1
    `)) as unknown as { hour: number; v: number }[],
    // The per-event breakdown + the unmapped count, off the SAME ledger and the
    // SAME occurred_at bucketing as `sales` and `revenue` above.
    (await db.execute(
      ledgerHourEventQuery({
        orgId,
        from: b.from,
        to: b.to,
        providerPhoneId: b.providerPhoneId,
      }),
    )) as unknown as {
      hour: number;
      event_key: string | null;
      n: number;
      pending_n: number;
      revenue: number;
      pending_revenue: number;
      unmapped: number;
    }[],
  ]);

  const hours = new Map<number, PerfMetrics>();
  // `events` is not a number, so it is excluded from the field parameter rather
  // than cast through: `(m[field] as number) += v` on a map would be silent.
  const bump = (h: number, field: Exclude<keyof PerfMetrics, "events">, v: number) => {
    // Hour buckets are built from tracked per-recipient events, so an hour with
    // no reach is a real 0 — unlike ZERO's null, which marks "no per-recipient data".
    if (!hours.has(h)) hours.set(h, { ...zeroMetrics(), reached: 0 });
    (hours.get(h)![field] as number) += v;
  };
  for (const r of sentRows) bump(r.hour, "sent", Number(r.v));
  for (const r of clicks) bump(r.hour, "clickers", Number(r.v));
  for (const r of redirects) {
    bump(r.hour, "redirects", Number(r.v));
    // Hourly "redirects" already IS per-recipient reach by reach hour.
    bump(r.hour, "reached", Number(r.v));
  }
  for (const r of clickerRows) bump(r.hour, "counted_clickers", Number(r.v));
  for (const r of sales) bump(r.hour, "sales", Number(r.v));
  for (const r of revenue) bump(r.hour, "revenue", Number(r.v));
  for (const r of pendingRevenue) bump(r.hour, "pending_revenue", Number(r.v));
  for (const r of evRows) {
    if (!hours.has(r.hour)) hours.set(r.hour, { ...zeroMetrics(), reached: 0 });
    const m = hours.get(r.hour)!;
    m.unmapped += Number(r.unmapped);
    // A NULL key IS the unmapped bucket — counted above and nowhere else.
    if (r.event_key == null) continue;
    const t = {
      n: Number(r.n),
      pending_n: Number(r.pending_n),
      revenue: Number(r.revenue),
      pending_revenue: Number(r.pending_revenue),
    };
    // ⭐ AN ALL-ZERO ENTRY IS NOT DATA, AND THE TWO PATHS MUST AGREE ON THAT.
    // The stage-day projection FILTERs such an entry out of its jsonb
    // (lib/keitaro/stage-day-conversions.ts) so a stage-day whose only row is a
    // REJECTED purchase reads `{}` rather than a row of zeros. This group exists
    // for the same reason — a rejected conversion still forms a (hour, key)
    // group — so emitting it here would put a key in hourly's map that By Offer
    // omits for identical data. visibleEventTypes() keys on a non-zero field, so
    // the rendered column set agrees either way (bar W21); the PAYLOAD did not,
    // and an absent key and a zeroed key are different claims.
    if (t.n === 0 && t.pending_n === 0 && t.revenue === 0 && t.pending_revenue === 0) continue;
    addEventMaps(m.events, { [r.event_key]: t });
  }
  for (const r of optouts) bump(r.hour, "opt_outs", Number(r.v));

  const rows: PerfRow[] = [...hours.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([h, m]) => ({
      key: String(h),
      label: formatEtHour(h),
      ...m,
      // `pending_revenue` is NOT overridden here any more. It used to be set to a
      // literal 0 — "the hourly tab renders no pending column, so this is
      // deliberately not computed" — which put a not-computed sentinel in the
      // same body as the real per-event figures. It is computed above.
    }));

  // Manual row (pinned first): all results from MANUAL campaigns mapped to the
  // range — manual sales by ledger entry date, plus manual-campaign opt-outs.
  const manual = await manualRangeRow(orgId, b);
  if (manual.sent > 0 || manual.sales > 0 || manual.opt_outs > 0 || manual.revenue > 0) {
    rows.unshift({ key: "manual", label: "Manual", pinned: true, ...manual });
  }

  const totals = rows.reduce((acc, r) => addMetrics(acc, r), zeroMetrics());
  // Hour rows dedupe clickers per hour; the total dedupes across the whole range.
  totals.counted_clickers = await getTotalCountedClickers(db, orgId, etRangeUtc(b), {
    providerPhoneId: b.providerPhoneId,
  });
  return { dimension: "hourly", rows, totals, refreshedAt: await maxSyncedAt(orgId) };
}

async function manualRangeRow(orgId: string, b: Bounds): Promise<PerfMetrics> {
  const { start: rangeStart, end: rangeEnd } = hourlyEtRange(b.from, b.to);
  const rows = (await db.execute(sql`
    SELECT
      coalesce((
        SELECT sum(sms.delta)::int FROM stage_manual_sales sms
        JOIN campaign_stages cs ON cs.id = sms.stage_id
        JOIN campaigns c ON c.id = cs.campaign_id AND c.link_mode = 'manual'
        WHERE sms.org_id = ${orgId}::uuid
          AND sms.created_at >= ${rangeStart} AND sms.created_at < ${rangeEnd}
      ), 0) AS sales,
      coalesce((
        SELECT count(*)::int FROM opt_out_attributions oa
        JOIN campaign_stages cs ON cs.id = oa.stage_id
        JOIN campaigns c ON c.id = cs.campaign_id AND c.link_mode = 'manual'
        WHERE oa.org_id = ${orgId}::uuid
          AND oa.created_at >= ${rangeStart} AND oa.created_at < ${rangeEnd}
      ), 0) AS opt_outs,
      coalesce((
        SELECT sum(cs.sms_count)::int FROM campaign_stages cs
        JOIN campaigns c ON c.id = cs.campaign_id AND c.link_mode = 'manual'
        WHERE cs.org_id = ${orgId}::uuid AND cs.archived_at IS NULL
          AND cs.sent_at >= ${rangeStart} AND cs.sent_at < ${rangeEnd}
      ), 0) AS sent
  `)) as unknown as { sales: number; opt_outs: number; sent: number }[];
  const r = rows[0] ?? { sales: 0, opt_outs: 0, sent: 0 };
  // No per-event breakdown, and that is not an omission: a manual-mode campaign
  // mints no links, so it has no tracker conversion at all. Its `sales` is the
  // manual tally, which is exactly what manual_topup means everywhere else.
  return {
    ...zeroMetrics(),
    sent: Number(r.sent) || 0,
    sales: Number(r.sales) || 0,
    manual_topup: Number(r.sales) || 0,
    opt_outs: Number(r.opt_outs) || 0,
  };
}

// ---- label + freshness helpers ---------------------------------------------
async function providerInfo(ids: number[]) {
  const out = new Map<
    number,
    { phone_number: string | null; number_type: string | null; provider_name: string | null; provider_color: string | null; account_label: string | null }
  >();
  if (ids.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT pp.id, pp.phone_number, pp.number_type, sp.name AS provider_name,
           sp.color AS provider_color, pc.label AS account_label
    FROM provider_phones pp
    LEFT JOIN sms_providers sp ON sp.id = pp.provider_id
    LEFT JOIN provider_credentials pc ON pc.id = pp.credential_id
    WHERE pp.id IN (${inList(ids)})
  `)) as unknown as Record<string, unknown>[];
  for (const r of rows) {
    out.set(Number(r.id), {
      phone_number: (r.phone_number as string) ?? null,
      number_type: (r.number_type as string) ?? null,
      provider_name: (r.provider_name as string) ?? null,
      provider_color: (r.provider_color as string) ?? null,
      account_label: (r.account_label as string) ?? null,
    });
  }
  return out;
}

async function offerInfo(ids: number[]) {
  const out = new Map<number, { code: string; name: string | null }>();
  if (ids.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT id, offer_id AS code, name FROM offers WHERE id IN (${inList(ids)})
  `)) as unknown as { id: number; code: string; name: string | null }[];
  for (const r of rows) out.set(Number(r.id), { code: r.code, name: r.name });
  return out;
}

async function creativeSlugs(orgId: string, ids: number[]) {
  const out = new Map<number, string>();
  if (ids.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT id, slug FROM creatives
    WHERE org_id = ${orgId}::uuid AND id IN (${inList([...new Set(ids)])})
  `)) as unknown as { id: number; slug: string }[];
  for (const r of rows) out.set(Number(r.id), r.slug);
  return out;
}

async function groupInfo(ids: number[]) {
  const out = new Map<number, { name: string; color: string | null }>();
  if (ids.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT id, name, color FROM contact_groups WHERE id IN (${inList(ids)})
  `)) as unknown as { id: number; name: string; color: string | null }[];
  for (const r of rows) out.set(Number(r.id), { name: r.name, color: r.color });
  return out;
}

async function maxSyncedAt(orgId: string): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT max(synced_at) AS t FROM keitaro_stage_results WHERE org_id = ${orgId}::uuid
  `)) as unknown as { t: string | null }[];
  return rows[0]?.t ?? null;
}

export async function getReportProviderOptions(orgId: string): Promise<ProviderOption[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT cs.provider_phone_id,
      pp.phone_number, pp.number_type,
      sp.name AS provider_name, sp.color AS provider_color, pc.label AS account_label
    FROM campaign_stages cs
    LEFT JOIN provider_phones pp ON pp.id = cs.provider_phone_id
    LEFT JOIN sms_providers sp ON sp.id = pp.provider_id
    LEFT JOIN provider_credentials pc ON pc.id = pp.credential_id
    WHERE cs.org_id = ${orgId}::uuid AND cs.provider_phone_id IS NOT NULL
    ORDER BY pp.phone_number
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    provider_phone_id: Number(r.provider_phone_id),
    phone_number: (r.phone_number as string) ?? null,
    number_type: (r.number_type as string) ?? null,
    provider_name: (r.provider_name as string) ?? null,
    provider_color: (r.provider_color as string) ?? null,
    account_label: (r.account_label as string) ?? null,
  }));
}

function formatEtHour(h: number): string {
  if (!Number.isFinite(h)) return "—";
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${period} ET`;
}
