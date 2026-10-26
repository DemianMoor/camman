// Pure, client-safe ratio for /reports/landing-pages, shared by the table and
// scripts/verify-lp-report-grains.ts so the null rule has one home.

/**
 * Sales % (of reached): sales ÷ recipients who reached the offer page, over the
 * row's Keitaro-covered tracked stages only. null — rendered `—`, never 0% —
 * when nothing in the row is covered (manual-only, tracking-gap-only) or nobody
 * reached the offer.
 */
export function salesPctOfReached(m: { reach_sales: number; reached: number; reach_covered_stages: number }): number | null {
  return m.reach_covered_stages > 0 && m.reached > 0 ? (m.reach_sales / m.reached) * 100 : null;
}

/**
 * CTR: of the row's Visitors, the share who also clicked the CTA and reached
 * the advertiser page — people ÷ people, both deduplicated, so it never passes
 * 100% even when one person was sent the page several times. Both sides cover
 * the row's Keitaro-covered tracked stages only, so manual visits and
 * tracking-gap stages (no reach data) cannot dilute it. null under the same
 * rule as Sales %.
 */
export function ctrOfVisitors(m: { redirected_visitors: number; reach_clicks: number; reach_covered_stages: number }): number | null {
  return m.reach_covered_stages > 0 && m.reach_clicks > 0 ? (m.redirected_visitors / m.reach_clicks) * 100 : null;
}
