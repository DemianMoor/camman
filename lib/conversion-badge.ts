// How a ledger conversion is RENDERED as a badge — colour and amount — for the
// campaign Activity → Messages list
// (components/campaigns/campaign-activity-section.tsx).
//
// Plain TS, no React, deliberately: these two decisions are the whole behaviour
// of that cell, and scripts/test-p3-task4-reader-switch-db.ts asserts them
// directly against the fixtures its SQL blocks create. Inside the .tsx they
// could only be re-implemented by a test, which is how a renderer and its proof
// drift apart.
//
// docs/04-features/conversion-events.md

/** Just the four fields the badge reads off an activity row. */
export interface ConversionBadgeInput {
  conversion_event: string | null;
  conversion_status: string | null;
  /** numeric(12,4) as text — so "0.0000" for a $0 event, which is TRUTHY. */
  conversion_revenue: string | null;
  /** NULL = unmapped event type (no event_types row matched). */
  conversion_is_purchase: boolean | null;
}

// conversion_events.status → badge colour for a PURCHASE. The LIFECYCLE status,
// not the network's raw Keitaro status: pending = a held payout (counted as a
// sale, NOT in revenue), approved = counted in Revenue/EPC, rejected = taken
// back.
export const CONVERSION_STATUS_STYLES: Record<string, string> = {
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  rejected: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
};

// A non-purchase event — today a $0 Registration, which is a retarget SIGNAL and
// not money. Sky, never the purchase green: keyed on status alone, an approved
// registration rendered in exactly the same emerald as a paid sale.
export const CONVERSION_SIGNAL_STYLE =
  "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300";

// No event_types match at all. Counts as nothing anywhere (not a purchase, not
// revenue), so it gets a neutral badge rather than borrowing a meaning.
export const CONVERSION_UNMAPPED_STYLE =
  "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";

/**
 * Badge colour. Needs BOTH facts — the lifecycle status AND whether the event is
 * a purchase. A rejected anything is red; an unmapped row is neutral; a
 * non-purchase signal is sky; only a real purchase gets the status colours.
 */
export function conversionBadgeClass(r: ConversionBadgeInput): string {
  if (r.conversion_status === "rejected") return CONVERSION_STATUS_STYLES.rejected;
  if (r.conversion_is_purchase == null) return CONVERSION_UNMAPPED_STYLE;
  if (!r.conversion_is_purchase) return CONVERSION_SIGNAL_STYLE;
  return CONVERSION_STATUS_STYLES[r.conversion_status ?? ""] ?? "";
}

/**
 * The amount to SHOW, or null when there is none.
 *
 * `conversion_revenue` arrives as numeric text, so a $0 registration is the
 * string "0.0000" — truthy, which is how the badge came to print "· $0.00" on an
 * event that carries no money at all. Rejected revenue is suppressed too: it was
 * taken back, and the badge already says `rejected`.
 */
export function conversionAmount(r: ConversionBadgeInput): number | null {
  if (r.conversion_status === "rejected") return null;
  const n = Number(r.conversion_revenue ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}
