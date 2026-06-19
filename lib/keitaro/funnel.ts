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
  cost: number | string;
}

export interface FunnelTally {
  visit_clicks_raw: number; // raw landing-page arrivals (diagnostic)
  visit_clicks_clean: number; // Clickers (headline)
  redirect_clicks_raw: number; // raw offer click-throughs (diagnostic)
  redirect_clicks_clean: number; // Offer Redirect (headline)
  sales: number;
  revenue: number;
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
  into.cost += from.cost;
  return into;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

// Derived funnel metrics from a tally. `clickers` / `offer_redirect` are the
// headline (clean) counts; rates chain down the funnel.
export function withFunnelDerived(t: FunnelTally) {
  return {
    ...t,
    clickers: t.visit_clicks_clean, // headline: clean visit clicks
    offer_redirect: t.redirect_clicks_clean, // headline: clean redirect clicks
    // share of visitors who clicked through to the offer
    redirect_rate: rate(t.redirect_clicks_clean, t.visit_clicks_clean),
    // share of offer redirects that converted to a sale
    sales_cr: rate(t.sales, t.redirect_clicks_clean),
    // earnings per offer redirect (clean)
    epc: rate(t.revenue, t.redirect_clicks_clean),
    profit: t.revenue - t.cost,
  };
}
