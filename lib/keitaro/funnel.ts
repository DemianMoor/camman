// Step 5b funnel: Clickers → Offer Redirect → Sales. Centralizes the legacy
// fallback and derived-rate math so the per-campaign results endpoint and the
// cross-campaign reports endpoint stay consistent.
//
// Subset semantics: every offer redirect is also a visit, so visits ⊇ redirects
// and they are NEVER summed — total arrivals = the visit (Clickers) count.
//
// Legacy fallback: pre-5b rows have all four split columns at 0 but may carry
// offer-redirect counts in the legacy `raw_clicks` / `clean_clicks`. For those
// rows we treat the legacy columns as the redirect side and visits as unknown (0)
// — pre-visit-tracking history had no landing-page visit data.

import { addEventMaps, parseEventMap, type EventMap } from "@/lib/reporting/event-columns";

// Structural shape of the columns we read. Accepts a raw Drizzle row (revenue /
// cost arrive as NUMERIC strings) or an aggregated SQL result.
export interface KeitaroResultRowLike {
  visit_clicks_raw: number;
  visit_clicks_clean: number;
  redirect_clicks_raw: number;
  redirect_clicks_clean: number;
  raw_clicks: number;
  clean_clicks: number;
  sales: number;
  revenue: number | string;
  /** keitaro_stage_results.events — jsonb, so the driver hands back parsed JS. */
  events?: unknown;
  unmapped_conversions?: number;
  pending_revenue: number | string;
  cost: number | string;
}

export interface FunnelTally {
  visit_clicks_raw: number; // raw landing-page arrivals (diagnostic)
  visit_clicks_clean: number; // Clickers (headline)
  redirect_clicks_raw: number; // raw offer click-throughs (diagnostic)
  redirect_clicks_clean: number; // Offer Redirect (headline)
  sales: number;
  revenue: number;
  /**
   * The SAME sales / revenue / pending_revenue numbers, split per
   * event_types.key (migration 0185). `sales` is the sum of the is_purchase
   * entries' `n` PLUS the manual top-up; `revenue` is the sum of every entry's
   * `revenue`, exactly. Keyed by `key`, never by id.
   */
  events: EventMap;
  /**
   * Conversions on these stage-days with no event type or no status. They are in
   * NO other field of this tally — not in sales, not in revenue, not in `events`.
   * Carried so a screen can say they exist; that is their only purpose.
   */
  unmapped: number;
  /**
   * The part of `sales` that came from the MANUAL tally (stage_manual_sales) and
   * not the tracker ledger, so the breakdown's standing identity holds on the
   * tally alone:
   *     Σ events[t].n over is_purchase types  +  manual_topup  +  strays  =  sales
   *
   * ⭐ IT IS A FIELD OF THE TALLY, NOT OF THE ROW. `addRowToFunnel` cannot set it
   * — keitaro_stage_results has no manual column, the top-up is computed against
   * stage_manual_sales in getStageMetricsInRange — so it is assigned there and
   * summed by `mergeFunnel` from then on. It rode as a SEPARATE per-stage field
   * before, which meant every consumer that presented `events` had to remember to
   * roll it up by hand at each grain; the Overview route did, three times, and
   * nothing failed if it had not. Here it rides the same spread as the breakdown
   * it explains.
   */
  manual_topup: number;
  pending_revenue: number;
  cost: number;
}

export function emptyFunnel(): FunnelTally {
  return {
    visit_clicks_raw: 0,
    visit_clicks_clean: 0,
    redirect_clicks_raw: 0,
    redirect_clicks_clean: 0,
    sales: 0,
    revenue: 0,
    // A FRESH object literal every call. Do NOT hoist this to a module constant:
    // two tallies would then share one map and merging into either would corrupt
    // the other (the EMPTY_TALLY aliasing bug, lib/reporting/event-columns.ts).
    events: {},
    unmapped: 0,
    manual_topup: 0,
    pending_revenue: 0,
    cost: 0,
  };
}

function num(v: number | string): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Whether this row carries the new visit/redirect split (any split column > 0).
function isSplitRow(r: KeitaroResultRowLike): boolean {
  return (
    r.visit_clicks_raw > 0 ||
    r.visit_clicks_clean > 0 ||
    r.redirect_clicks_raw > 0 ||
    r.redirect_clicks_clean > 0
  );
}

// Add one stored row into a tally, applying the legacy fallback. Returns the
// tally for chaining.
export function addRowToFunnel(
  t: FunnelTally,
  r: KeitaroResultRowLike,
): FunnelTally {
  const split = isSplitRow(r);
  t.visit_clicks_raw += r.visit_clicks_raw;
  t.visit_clicks_clean += r.visit_clicks_clean;
  t.redirect_clicks_raw += split ? r.redirect_clicks_raw : r.raw_clicks;
  t.redirect_clicks_clean += split ? r.redirect_clicks_clean : r.clean_clicks;
  t.sales += r.sales;
  t.revenue += num(r.revenue);
  addEventMaps(t.events, parseEventMap(r.events));
  t.unmapped += r.unmapped_conversions ?? 0;
  // `manual_topup` is deliberately NOT touched here: a stored Keitaro row carries
  // no manual column. It is assigned in getStageMetricsInRange, which is where
  // the manual tally is read, and summed by mergeFunnel below.
  t.pending_revenue += num(r.pending_revenue);
  t.cost += num(r.cost);
  return t;
}

// Sum one tally into another (e.g. rolling per-stage tallies up to a campaign).
// Mirrors addRowToFunnel but for already-folded FunnelTally values. Returns the
// target for chaining.
export function mergeFunnel(into: FunnelTally, from: FunnelTally): FunnelTally {
  into.visit_clicks_raw += from.visit_clicks_raw;
  into.visit_clicks_clean += from.visit_clicks_clean;
  into.redirect_clicks_raw += from.redirect_clicks_raw;
  into.redirect_clicks_clean += from.redirect_clicks_clean;
  into.sales += from.sales;
  into.revenue += from.revenue;
  addEventMaps(into.events, from.events);
  into.unmapped += from.unmapped;
  into.manual_topup += from.manual_topup;
  into.pending_revenue += from.pending_revenue;
  into.cost += from.cost;
  return into;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/** The three fields that make up the per-event breakdown and its residuals. */
export const EVENT_BREAKDOWN_FIELDS = ["events", "unmapped", "manual_topup"] as const;

/**
 * Drop the per-event breakdown — and BOTH residuals with it — from a derived
 * tally, for a reader that does not select the columns behind them.
 *
 * ⭐ AN ABSENT FIELD AND AN EMPTY MAP ARE DIFFERENT CLAIMS. A caller that builds
 * its tally from a projection WITHOUT `events` / `unmapped_conversions` (that is
 * every row addRowToFunnel sees with those keys undefined) still gets
 * `events: {}` and `unmapped: 0` — which says "measured, and nothing happened"
 * when the truth is "not selected, so unknown". Emitting that in an API body
 * invites a consumer to read a breakdown that was never computed. There is no
 * third state to invent: the field simply does not appear.
 *
 * All THREE go together, never one of them: a breakdown that is absent has no
 * residual to carry, and a residual with no breakdown beside it explains nothing
 * (docs/07-conventions.md, "A breakdown must travel with the residual that
 * explains it").
 */
export function withoutEventBreakdown<T extends Pick<FunnelTally, "events" | "unmapped" | "manual_topup">>(
  t: T,
): Omit<T, "events" | "unmapped" | "manual_topup"> {
  const out = { ...t };
  for (const f of EVENT_BREAKDOWN_FIELDS) delete (out as Partial<T>)[f];
  return out;
}

// Derived funnel metrics from a tally. `clickers` / `offer_redirect` are the
// headline (clean) counts; rates chain down the funnel.
//
// `countedClickers` is REQUIRED, deliberately. It is the platform-wide EPC
// denominator from lib/reporting/counted-clickers.ts, and making it a required
// parameter is what makes "no fallback to the old denominator" a compile-time
// guarantee rather than a convention — there is no overload that divides by
// redirects any more, so a new caller cannot accidentally reintroduce one.
//
// It is NOT derivable from the tally: the tally holds Keitaro aggregates, while
// the denominator is CamMan's own deduplicated counted-clicker set (or, for
// manual-mode campaigns which mint no links, Keitaro's clean landing visits).
// Callers resolve it with denominatorFor() and pass it in.
//
// `pending_revenue` rides along untouched — it is NOT in epc, sales_cr or
// profit. Revenue is approved-only (lib/sale-attribution.ts) and pending is the
// same money still held, so adding it anywhere would count a payout that may yet
// be rejected.
//
// `events`, `unmapped` and `manual_topup` ride along untouched: no derived rate
// is computed here, and the three travel TOGETHER because the breakdown does not
// explain Sales without the two residuals beside it (docs/07-conventions.md).
// Per-event rates and EPCs are built at render time by eventCellValue()
// (lib/reporting/event-columns.ts), which divides by the SAME countedClickers
// this function takes — there is no second denominator.
export function withFunnelDerived(t: FunnelTally, countedClickers: number) {
  return {
    ...t,
    clickers: t.visit_clicks_clean, // headline: clean visit clicks
    offer_redirect: t.redirect_clicks_clean, // headline: clean redirect clicks
    // The EPC denominator, surfaced so every screen can show the click count
    // next to EPC — the grain is only readable if the count is visible.
    counted_clickers: countedClickers,
    // share of visitors who clicked through to the offer
    redirect_rate: rate(t.redirect_clicks_clean, t.visit_clicks_clean),
    // share of offer redirects that converted to a sale
    sales_cr: rate(t.sales, t.redirect_clicks_clean),
    // earnings per COUNTED CLICKER (was: per clean offer redirect, until
    // 2026-08-11 — that denominator was ~8x smaller and inconsistent with every
    // other surface). See docs/04-features/tracking-attribution.md.
    epc: rate(t.revenue, countedClickers),
    profit: t.revenue - t.cost,
  };
}
