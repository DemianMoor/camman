// NET Profit and ROI for the partner report. Its own module (not in
// partner-report.ts, which is server-only) because the client view computes the
// totals line with it too — one rule for rows and totals, so they cannot drift.
export function profitAndRoi(
  revenue: number,
  sendCost: number,
  lookupCost: number,
): { net_profit_usd: number; roi: number | null } {
  const cost = sendCost + lookupCost;
  const net = revenue - cost;
  // ⚠️ null ("—"), not 0%: a return on zero spend is undefined.
  return { net_profit_usd: net, roi: cost > 0 ? net / cost : null };
}
