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
