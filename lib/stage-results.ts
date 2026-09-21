// Revenue / ROI math for stage results.
//
// IMPORTANT: the REVENUE SOURCE OF TRUTH is keitaro_stage_results.revenue (the
// real per-conversion payout recorded by Keitaro at sync time). Reported and
// stored revenue everywhere — dashboards, reports, the campaign detail page —
// is summed from that column, NEVER from sales × the offer CPA. A CPA that
// changes mid-flight (offers.payout_cpa) would retro-misprice every prior sale.
//
// `stageRevenue` (sales × payout) survives ONLY as the manual-results form's
// live, pre-save ESTIMATE while an operator types a sales count for a stage
// with no Keitaro tracking. It is never persisted or shown as actual revenue.
// `stageRoi`/`formatRevenue`/`formatRoi` are the shared display helpers.

// Effective Sales for a stage = max(manual tally, Keitaro conversions) — NOT the
// sum. A sale that Keitaro tracks AND the operator tallied manually is the SAME
// sale, so summing double-counted it (Keitaro 1 + manual 1 = 2 for one real
// sale). We take the larger of the two: it dedupes the overlap (assuming the
// smaller set ⊆ the larger) while preserving whichever source saw more — Keitaro
// when it's ahead, and the manual baseline on stages where Keitaro under-counts
// (incomplete sub_id capture). Mirrors the /reports route rule.
export function combineSales(
  manualSales: number,
  keitaroSales: number,
): number {
  return Math.max(manualSales, keitaroSales);
}

// The part of that effective Sales figure the MANUAL tally contributed — the
// second residual of the per-event breakdown, and the reason a screen can show
// "Purchases: 2" beside "Sales: 5" with only 1 stray to blame.
//
// ⭐ DERIVED FROM combineSales(), NOT RE-DERIVED AS max(m - k, 0). They are the
// same number today, and writing it this way is what keeps them the same number
// if the dedupe rule above ever changes: this is defined as "what Sales carries
// that the tracker did not report", which is the property every caller wants.
// Mirrors `greatest(m_sales - k_sales, 0)` in lib/reporting/attribution.ts and
// `greatest(cs.sales_count - ks.sales, 0)` in lib/creatives/metrics-cache.ts.
export function manualSalesTopup(
  manualSales: number,
  keitaroSales: number,
): number {
  return combineSales(manualSales, keitaroSales) - keitaroSales;
}

// Returns null when the per-sale payout is unknown (no offer CPA snapshotted),
// so callers can render "—" instead of a misleading $0.
export function stageRevenue(
  salesCount: number,
  payoutEach: number | null | undefined,
): number | null {
  if (payoutEach == null || !Number.isFinite(payoutEach)) return null;
  if (salesCount <= 0) return 0;
  return salesCount * payoutEach;
}

// ROI as a ratio (0.5 = +50%). Null when revenue is unknown or there's no
// cost to divide by.
//
// `pendingRevenue` (Phase 3, 2026-09-17) is money a conversion earned that the
// network has not approved yet. It is NEVER in the ratio — ROI counts approved
// revenue only, like EPC and profit. But when approved revenue is 0 and held
// money exists, the honest answer is "not decided yet", not `-100%`: the ratio
// would read as a total loss on a campaign whose payout is merely in flight, and
// -100% is the one number that makes someone kill a campaign. Null in that case,
// which every caller already renders as "—" beside the visible pending figure.
export function stageRoi(
  revenue: number | null,
  cost: number,
  pendingRevenue = 0,
): number | null {
  if (revenue == null) return null;
  if (!(cost > 0)) return null;
  if (revenue === 0 && pendingRevenue > 0) return null;
  return (revenue - cost) / cost;
}

export function formatRoi(roi: number | null): string {
  if (roi == null) return "—";
  return `${roi >= 0 ? "+" : ""}${(roi * 100).toFixed(0)}%`;
}

export function formatRevenue(revenue: number | null): string {
  if (revenue == null) return "—";
  return `$${revenue.toFixed(2)}`;
}
