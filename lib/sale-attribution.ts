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
// arriving as `lead` made the contact read as a BUYER — at the time, the top of
// the behavioural scale: a buyer in the segment rules, its drip journey closed as
// purchased, dropped from every lane. (That top value was renumbered from 3 to 4
// in Phase 4, when Registered took 3; the historical bug is unchanged, only the
// number it used to be written with. lib/campaign-tier.ts holds the scale.)
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
 * Zero rows in production today — the mapping exists, no registration has
 * arrived yet.
 *
 * ⚠️ THIS PREDICATE IS HALF OF A DEFINITION, NEVER THE WHOLE OF ONE. "Registered"
 * as a behavioural TIER means "registered AND has not bought", so every consumer
 * below pairs it with a `NOT EXISTS` over PURCHASE_EVENT_TYPE_IDS at any KNOWN
 * status (see lib/campaign-tier.ts for why that cannot be left to MAX). A new
 * consumer that uses this clause alone is asserting something different — that a
 * registration merely happened — and should say so at the call site.
 *
 * CONSUMERS (three, all behavioural; none reporting):
 *   • lib/campaign-tier.ts — the tier-3 branch of campaignTierExpr, the one
 *     definition of a Registered lane's audience.
 *   • lib/drip/lifecycle.ts — TWICE, in the inlined tier ladders of
 *     closeCompletedJourneys() and expireJourneysPastEndDate(). They cannot
 *     import campaignTierExpr (it takes a literal campaign id; they need the
 *     tier correlated per journey row), so the two copies must be kept in step
 *     with this file and with each other — pinned by
 *     scripts/test-campaign-tier-scale.ts bars P20-P26.
 * Phase 5's per-event report columns will be a fourth. Reporting does NOT read
 * this: a registration is not a sale, not revenue, and not a counted clicker.
 */
export function registeredClause(alias = "ce"): SQL {
  const a = sql.raw(alias);
  return sql`${a}.event_type_id IN ${RETARGET_EVENT_TYPE_IDS} AND ${a}.status IN ('pending', 'approved')`;
}

/**
 * The recipient rows that carry a counted purchase, as a set to JOIN against.
 * For a reader that scans stage_sends wholesale: a hash join against ~1.5K
 * ledger rows, instead of an EXISTS probe per send row.
 *
 * CONSUMER (exactly one, today): lib/audience/pools.ts — the operator audience
 * pools. The by-group `sale` weights and the rollup do NOT use this; they need a
 * per-send COUNT and revenue, which is purchasesBySendSelect below. Do not
 * describe this helper by the readers it might have.
 *
 * `orgId = null` drops the org filter, for a CROSS-ORG cache rebuild that writes
 * every org's rows in one statement and carries org_id from the send row (see
 * rescueSendIds's caller, lib/reporting/counted-clickers.ts). Anything serving a
 * request passes a real org id.
 */
export function purchasedSendIds(orgId: string | null): SQL {
  const org = orgId === null ? sql`` : sql`AND ce.org_id = ${orgId}::uuid`;
  return sql`
    SELECT DISTINCT ce.stage_send_id
    FROM conversion_events ce
    WHERE ce.stage_send_id IS NOT NULL
      ${org}
      AND ${purchasedClause()}`;
}

/**
 * The Rule F rescue set (lib/reporting/counted-clickers.ts): every recipient
 * whose conversion could put revenue in the EPC numerator, so the numerator can
 * never sit outside the click denominator. Purchase OR revenue-bearing, not
 * rejected. `first_event_at` is the fallback first-click stamp for a rescued row.
 * `window` narrows the scan on the incremental pass. `orgId = null` is cross-org
 * — see purchasedSendIds.
 *
 * CONSUMERS: lib/reporting/counted-clickers.ts (the rebuild) and
 * scripts/verify-counted-clickers.ts (its guard, which must assert the rescue
 * rule the cache actually uses — not a retyped copy of the pre-ledger one).
 */
export function rescueSendIds(orgId: string | null, window: SQL = sql``): SQL {
  const org = orgId === null ? sql`` : sql`AND ce.org_id = ${orgId}::uuid`;
  return sql`
    SELECT ce.stage_send_id, min(ce.occurred_at) AS first_event_at
    FROM conversion_events ce
    WHERE ce.stage_send_id IS NOT NULL
      AND ce.status IN ('pending', 'approved')
      AND (ce.event_type_id IN ${PURCHASE_EVENT_TYPE_IDS}
           OR ce.event_type_id IN ${REVENUE_EVENT_TYPE_IDS})
      ${org}
      ${window}
    GROUP BY 1`;
}

/**
 * Counted purchases and APPROVED revenue per RECIPIENT ROW, as a SELECT to join
 * on `stage_send_id`. ONE definition for the two readers that need the pair:
 * the partner report's `purchases` CTE (lib/reporting/partner-report.ts) and the
 * dormant rollup's `conv_sends` CTE (lib/reporting/rollup.ts). They used to
 * carry the same six lines literally, which is how a shape drifts.
 *
 * Counting ledger EVENTS, not send rows that carry a status: a recipient with
 * two conversions is two sales and both payouts, where
 * stage_sends.sale_status/sale_revenue kept only the latest (measured 2026-09-17:
 * 14 recipients, $715 of purchases dropped). Revenue is APPROVED only — a held
 * payout is not revenue. A row that is neither (a rejected conversion, an
 * UNMAPPED row with a NULL event_type_id) contributes 0 purchases and $0: it is
 * present in the group and counts as nothing, which is the point.
 *
 * `restrict` is an extra AND on `ce`, and it is how a caller BOUNDS the scan —
 * without it this aggregates the WHOLE ledger on every call, which is ~1.5K rows
 * today and unbounded growth later. Pass a predicate that can only drop rows the
 * caller's own join would discard anyway, so the bound cannot change a number.
 *
 * `orgId = null` is cross-org — see purchasedSendIds.
 */
export function purchasesBySendSelect(orgId: string | null, restrict: SQL = sql``): SQL {
  const org = orgId === null ? sql`` : sql`AND ce.org_id = ${orgId}::uuid`;
  return sql`
    SELECT ce.stage_send_id,
           count(*) FILTER (WHERE ${purchasedClause()})::int AS purchases,
           coalesce(sum(ce.revenue) FILTER (WHERE ${approvedRevenueClause()}), 0)::numeric(12, 4) AS revenue
    FROM conversion_events ce
    WHERE ce.stage_send_id IS NOT NULL
      ${org}
      ${restrict}
    GROUP BY 1`;
}

/**
 * The recipient's LATEST ledger conversion — the body of a `LEFT JOIN LATERAL`
 * over a `stage_sends` alias. Used by the campaign-activity badge
 * (app/api/campaigns/[campaignId]/activity/messages/route.ts) and by its proof
 * (scripts/test-p3-task4-reader-switch-db.ts), which is why it lives here rather
 * than inline in a route file: a Next.js route may only export route fields, so
 * a fragment a test needs to execute cannot live there.
 *
 * A recipient can carry SEVERAL conversions (a $0 registration and a paid
 * purchase); the badge shows the most recent, with its lifecycle status, where
 * the old sale_status/sale_revenue pair rendered a registration as "lead ·
 * $0.00". `is_purchase` travels with it because status alone cannot tell an
 * approved $0 registration from an approved sale — the badge colours on both.
 * NULL `is_purchase` means the event type is unmapped (no event_types row): it
 * is neither a purchase nor revenue anywhere, and the badge says "unmapped".
 *
 * `ce.org_id = <send>.org_id` is redundant given stage_send_id is a UUID primary
 * key, and deliberate: every ledger read in the app is org-filtered, and the
 * pair is what the (org_id, …) indexes are built for.
 */
export function latestConversionForSend(sendAlias = "ss"): SQL {
  const s = sql.raw(sendAlias);
  return sql`
    SELECT coalesce(et.label, ce.keitaro_type) AS event_label,
           ce.status AS status,
           ce.revenue::text AS revenue,
           et.is_purchase AS is_purchase
    FROM conversion_events ce
    LEFT JOIN event_types et ON et.id = ce.event_type_id
    WHERE ce.stage_send_id = ${s}.id
      AND ce.org_id = ${s}.org_id
    ORDER BY ce.occurred_at DESC, ce.id DESC
    LIMIT 1`;
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
