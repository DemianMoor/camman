import { sql, type SQL } from "drizzle-orm";

// SINGLE SOURCE OF TRUTH for "this recipient bought" as read off a stage_sends
// row. Every consumer that asks "is this contact a buyer?" MUST go through
// `purchasedClause` so the answer can't drift between reporting and targeting.
//
// WHY THIS ISN'T `sale_status = 'sale'`:
// `stage_sends.sale_status` stores the affiliate network's RAW Keitaro postback
// status, verbatim. This account's network fires `lead`-status postbacks for
// PAID conversions — it effectively never sends `sale` (confirmed via a direct
// probe 2026-06-19; the only two `sale` rows org-wide came from a single stage
// on 2026-06-24). So a `= 'sale'` test finds essentially nobody, even though
// every one of those `lead` rows carries real payout revenue.
//
// Both reporting surfaces already count any non-rejected conversion as a sale:
//   lib/keitaro/poll.ts       → `agg.sales += 1` for EVERY conversion row
//   lib/reporting/rollup.ts   → `(ss.converted_at IS NOT NULL)::int AS sale`
// The segment rules and the campaign-tier converted lane used `= 'sale'` and so
// disagreed with the Sales figure on every report (835 buyers vs 2). This clause
// is the reconciliation.
//
// `rejected` is deliberately NOT a purchase — it's a refund / chargeback /
// fraud screen, i.e. a conversion that was taken back.
export const PURCHASE_SALE_STATUSES = ["lead", "sale"] as const;

// Predicate for ONE stage_sends row, qualified by its table alias. Stays
// sargable against the partial index `stage_sends_sale_status_idx`
// (WHERE sale_status IS NOT NULL), so no migration is needed.
export function purchasedClause(alias = "ss"): SQL {
  return sql`${sql.raw(alias)}.sale_status IN ('lead', 'sale')`;
}
