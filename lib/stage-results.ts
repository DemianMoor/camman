// Revenue / ROI math for stage results. Shared by the manual-results form
// (live preview) and the campaign detail page (per-stage + rollup) so the
// numbers can never diverge.
//
// Revenue = sales × the offer CPA payout snapshotted on the stage when the
// sales count was entered (campaign_stages.sales_payout_each). ROI uses the
// stage's send cost (total_cost) as the cost basis: (revenue − cost) / cost.

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
