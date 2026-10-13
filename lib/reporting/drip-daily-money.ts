import { profitAndRoi } from "./partner-profit";

// Money columns of the drip Daily results tab, from SUMMED rollup cells — one
// rule for a day row, a breakdown row and the totals row, so they cannot drift
// (owner ruling Q1 + Q3, 2026-10-12). Client-safe: no server-only import, so the
// tab's totals line can call it too. The rate is passed in (getCalibratedLookupRate
// is server-only).
//
//   Lookup cost  = admitted leads × the calibrated lookup rate — the SAME rate
//                  the partner report prices lookups at. Exact per campaign
//                  because a lead is admitted to at most one campaign; lookups
//                  of leads never admitted (incl. landlines) stay in the partner
//                  report only. A lead whose number hit the lookup cache cost
//                  nothing (~1%), so this slightly overstates — say so in the UI.
//   Profit       = revenue − send cost − lookup cost   (profitAndRoi, the partner
//                  report's NET rule)
//   ROI          = Profit ÷ (send cost + lookup cost); null when that is 0
//   Revenue per admitted lead (Cohort) = Σ revenue ÷ Σ admitted; null over 0

/**
 * ROI is shown as "—" when the row's send cost is under this (owner, 2026-10-13):
 * a few dollars of revenue over a few cents of cost reads as 14,000% and means
 * nothing. Display rule only — the API still returns the computed ROI.
 */
export const ROI_MIN_SEND_COST_USD = 1;

/** The ROI a row DISPLAYS: null ("—") under ROI_MIN_SEND_COST_USD of send cost. */
export function displayedRoi(roi: number | null, sendCostUsd: number): number | null {
  return sendCostUsd < ROI_MIN_SEND_COST_USD ? null : roi;
}

export interface DailyMoneyInput {
  revenue: number;
  send_cost: number;
  admitted: number;
}

export interface DailyMoney {
  revenue_usd: number;
  send_cost_usd: number;
  lookup_cost_usd: number;
  profit_usd: number;
  roi: number | null;
  revenue_per_admitted_usd: number | null;
}

export function dailyMoney(sums: DailyMoneyInput, lookupRateUsd: number): DailyMoney {
  const lookup = sums.admitted * lookupRateUsd;
  const { net_profit_usd, roi } = profitAndRoi(sums.revenue, sums.send_cost, lookup);
  return {
    revenue_usd: sums.revenue,
    send_cost_usd: sums.send_cost,
    lookup_cost_usd: lookup,
    profit_usd: net_profit_usd,
    roi,
    revenue_per_admitted_usd: sums.admitted > 0 ? sums.revenue / sums.admitted : null,
  };
}
