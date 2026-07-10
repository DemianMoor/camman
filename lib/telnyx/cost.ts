import type { LineType } from "./types";

export interface LookupRates {
  base: number; // USD per lookup (LRN base) — lookup_settings.lookup_rate_base
  mobile: number; // USD surcharge, MOBILE results only — lookup_settings.lookup_rate_mobile
}

// Default mobile share used for the pre-run cost ESTIMATE when the true mix is
// unknown (the account's historical mobile fraction; refine from data later).
export const DEFAULT_MOBILE_SHARE = 0.35;

// Pre-run estimate: base applies to every lookup; the mobile surcharge applies to
// the estimated mobile share. Labeled "estimate" in the UI.
export function estimateLookupCost(
  count: number,
  rates: LookupRates,
  mobileShare: number = DEFAULT_MOBILE_SHARE,
): number {
  if (count <= 0) return 0;
  const share = Math.min(1, Math.max(0, mobileShare));
  return round4(count * rates.base + count * share * rates.mobile);
}

// Actual cost from the observed line-type mix: base on every lookup, mobile
// surcharge only on 'mobile' results (confirmed mobile-only per Telnyx pricing).
export function actualLookupCost(
  lineTypeCounts: Partial<Record<LineType, number>>,
  rates: LookupRates,
): number {
  const total = Object.values(lineTypeCounts).reduce(
    (a, b) => a + (b ?? 0),
    0,
  );
  const mobile = lineTypeCounts.mobile ?? 0;
  return round4(total * rates.base + mobile * rates.mobile);
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
