// Pure grading-rate math for the operator API's creative-grading fields. NO
// database import: scripts assert on it directly and a client component may use
// it. Definitions: docs/07-conventions.md "Grading metrics".

/**
 * A percentage in percent units (3.04 = 3.04%), rounded to 2 decimals.
 * null when either side is unknowable or the denominator is not positive — a
 * rate that cannot be computed must never read as a real 0.
 */
export function pct(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

export interface GradingInputs {
  sent: number;
  opt_outs: number;
  /** Distinct human clickers (the counted-clicker / EPC denominator). */
  clicks_human: number;
  /** null when the row includes a manual-mode stage: no per-recipient reach exists. */
  reached: number | null;
  /** Tracker conversions. */
  conversions: number;
}

export interface GradingRates {
  click_to_reach_pct: number | null;
  reach_to_sale_pct: number | null;
  opt_rate: number | null;
}

export function gradingRates(m: GradingInputs): GradingRates {
  return {
    // May exceed 100 and is NOT clamped: a recipient can reach the offer
    // without a click the scorer called human.
    click_to_reach_pct: pct(m.reached, m.clicks_human),
    reach_to_sale_pct: pct(m.conversions, m.reached),
    opt_rate: pct(m.opt_outs, m.sent),
  };
}

/**
 * Sum where null means "this part has no per-recipient data" (a manual-mode
 * stage). Known parts add up and null parts are skipped; only a row whose parts
 * are ALL null stays null. Absorbing nulls would null nearly every report total:
 * old manual campaigns keep trickling Keitaro visits into any range (13 of 836
 * stages over 2026-09-07..13, carrying 7 of 12,769 visits and 0 sales).
 */
export function addNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return a + b;
}
