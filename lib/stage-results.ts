// Revenue / ROI math for stage results. Shared by the manual-results form
// (live preview) and the campaign detail page (per-stage + rollup) so the
// numbers can never diverge.
//
// Revenue = sales × the offer CPA payout snapshotted on the stage when the
// sales count was entered (campaign_stages.sales_payout_each). ROI uses the
// stage's send cost (total_cost) as the cost basis: (revenue − cost) / cost.

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
