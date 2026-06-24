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
export function stageRoi(
  revenue: number | null,
  cost: number,
): number | null {
  if (revenue == null) return null;
  if (!(cost > 0)) return null;
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
