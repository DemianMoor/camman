import { sql, type SQL } from "drizzle-orm";

// SINGLE SOURCE OF TRUTH for "this recipient bought", "this revenue counts",
// "this revenue is still pending" and "this is a retarget signal (registration)".
// Every consumer MUST come through here so the answer cannot drift between
// targeting and reporting.
//
// THE SOURCE IS THE LEDGER, NOT stage_sends (Phase 3, 2026-09-17).
// `conversion_events` (migration 0181) holds ONE ROW PER KEITARO CONVERSION, so
// a click can carry a $0 registration and a paid purchase at the same time.
// `stage_sends.sale_status` could only ever hold ONE conversion per recipient —
// latest `datetime` wins — which meant a registration arriving after a purchase
// overwrote the purchase (measured: 14 recipients, $715 lost) and a registration
// arriving as `lead` made the contact read as a BUYER: tier 3, a buyer in the
// segment rules, its drip journey closed as purchased, dropped from every lane.
//
// The alias these predicates take is a `conversion_events` row (default "ce"),
// NOT a `stage_sends` row. Call sites select FROM the ledger. That is deliberate:
//   • the ledger's indexes (contact_id, event_type_id) and
//     (campaign_id, event_type_id, contact_id) answer the targeting questions
//     from a handful of rows, where an EXISTS per recipient would probe once per
//     send row of a campaign;
//   • the two report matviews cannot import TypeScript, so they carry the same
//     predicate text literally — one definition, copied. Phase 3 Task 7's
//     scripts/verify-conversion-reader-switch.ts will assert the copies agree;
//     it does not exist yet.
//
// docs/04-features/conversion-events.md · docs/04-features/epc-denominator.md

// A conversion that has not been taken back. `rejected` is deliberately NOT
// counted — it is a refund / chargeback / fraud screen. `pending` IS counted for
// PURCHASE (a held purchase is still a purchase for targeting and for the Sales
// count) but NOT for revenue (see approvedRevenueClause).
// No consumer outside the pure test (scripts/test-ledger-predicates.ts P12) reads
// this constant — every clause below embeds 'pending'/'approved' as a literal, not
// a reference to this array, because the two report matviews need literal SQL.
// Changing this constant changes nothing at runtime; the clauses are the truth.
export const COUNTED_CONVERSION_STATUSES = ["pending", "approved"] as const;

// The event-type flag sets, as SQL. Deliberately NOT a cached id set in TS:
// the matviews need the predicate as pure SQL, event_types holds 2 rows per org
// (the subplan is hashed once), a cache would need an org context the cross-org
// readers don't have, and turning the set into a JS array is the forbidden
// interpolation pattern. There is no `status = 'active'` filter — archiving an
// event type must never retroactively erase its history from revenue.
export const PURCHASE_EVENT_TYPE_IDS: SQL = sql`(SELECT et.id FROM event_types et WHERE et.is_purchase)`;
export const REVENUE_EVENT_TYPE_IDS: SQL = sql`(SELECT et.id FROM event_types et WHERE et.counts_revenue)`;
export const RETARGET_EVENT_TYPE_IDS: SQL = sql`(SELECT et.id FROM event_types et WHERE et.is_retarget_signal)`;

/**
 * A counted PURCHASE event on the aliased conversion_events row.
 *
 * PARENTHESISED: this is an `A AND B` conjunction, and a call site that drops it
 * into an `OR` (`... OR ${purchasedClause()}`) would otherwise bind as
 * `(x OR A) AND B` and silently mean something else.
 */
export function purchasedClause(alias = "ce"): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.event_type_id IN ${PURCHASE_EVENT_TYPE_IDS} AND ${a}.status IN ('pending', 'approved'))`;
}

/** Revenue that counts toward Revenue / EPC: approved only, on the aliased conversion_events row. */
export function approvedRevenueClause(alias = "ce"): SQL {
  const a = sql.raw(alias);
  return sql`${a}.event_type_id IN ${REVENUE_EVENT_TYPE_IDS} AND ${a}.status = 'approved'`;
}

/**
 * Revenue that is NOT yet approved, on the aliased conversion_events row. A
 * SEPARATE figure — never added into revenue, never in EPC, never in profit/ROI.
 */
export function pendingRevenueClause(alias = "ce"): SQL {
  const a = sql.raw(alias);
  return sql`${a}.event_type_id IN ${REVENUE_EVENT_TYPE_IDS} AND ${a}.status = 'pending'`;
}

/**
 * A retarget signal (today: Registration), on the aliased conversion_events row.
 * Feeds the Phase 4 "Registered — not purchased" lane and the registration
 * columns Phase 5 adds. Zero rows today.
 */
export function registeredClause(alias = "ce"): SQL {
  const a = sql.raw(alias);
  return sql`${a}.event_type_id IN ${RETARGET_EVENT_TYPE_IDS} AND ${a}.status IN ('pending', 'approved')`;
}

/**
 * The recipient rows that carry a counted purchase, as a set to JOIN against.
 * For readers that scan stage_sends wholesale (operator pools, the by-group
 * weights, the rollup): a hash join against ~1.5K ledger rows, instead of an
 * EXISTS probe per send row.
 */
export function purchasedSendIds(orgId: string): SQL {
  return sql`
    SELECT DISTINCT ce.stage_send_id
    FROM conversion_events ce
    WHERE ce.org_id = ${orgId}::uuid
      AND ce.stage_send_id IS NOT NULL
      AND ${purchasedClause()}`;
}

/**
 * The Rule F rescue set (lib/reporting/counted-clickers.ts): every recipient
 * whose conversion could put revenue in the EPC numerator, so the numerator can
 * never sit outside the click denominator. Purchase OR revenue-bearing, not
 * rejected. `first_event_at` is the fallback first-click stamp for a rescued row.
 * `sinceWindow` narrows the scan on the incremental pass.
 */
export function rescueSendIds(orgId: string, sinceWindow: SQL = sql``): SQL {
  return sql`
    SELECT ce.stage_send_id, min(ce.occurred_at) AS first_event_at
    FROM conversion_events ce
    WHERE ce.org_id = ${orgId}::uuid
      AND ce.stage_send_id IS NOT NULL
      AND ce.status IN ('pending', 'approved')
      AND (ce.event_type_id IN ${PURCHASE_EVENT_TYPE_IDS}
           OR ce.event_type_id IN ${REVENUE_EVENT_TYPE_IDS})
      ${sinceWindow}
    GROUP BY 1`;
}

// ── legacy, frozen ──────────────────────────────────────────────────────────
// The pre-ledger definition, kept for ONE purpose: the proof script computes the
// OLD number next to the new one (scripts/verify-conversion-reader-switch.ts).
//
// Neither verify-keitaro-batch-update.ts nor smoke-prod-purchase-rule.ts imports
// this module. verify-keitaro-batch-update.ts only asserts raw stage_sends column
// values after an UPSERT (sale_status/sale_revenue/converted_at round-trip),
// unrelated to purchase semantics. smoke-prod-purchase-rule.ts inlines
// `ss.sale_status IN ('lead','sale')` as its own literal — a second, uncoupled
// copy of this definition that will keep existing, and can silently drift, until
// Phase 3 retires it.
//
// DO NOT use it in app code. `stage_sends.sale_status` holds the affiliate
// network's raw Keitaro status for the LATEST conversion only; this account's
// networks fire `lead`-status postbacks for paid conversions, which is why the
// test is a status list and not `= 'sale'` (that found 2 buyers where the truth
// was ~835). The columns keep being written by lib/keitaro/poll-conversions.ts
// until a later card drops them.
//
// This constant itself has NO consumer anywhere, not even legacySaleStatusPurchasedClause
// below (which hardcodes 'lead','sale' directly) or the pure test — it documents
// the value, it does not drive it. Changing it changes nothing at runtime.
export const PURCHASE_SALE_STATUSES = ["lead", "sale"] as const;

export function legacySaleStatusPurchasedClause(alias = "ss"): SQL {
  const a = sql.raw(alias);
  return sql`${a}.sale_status IN ('lead', 'sale')`;
}
