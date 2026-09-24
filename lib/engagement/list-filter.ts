import { sql, type SQL } from "drizzle-orm";

import { contacts } from "@/db/schema";
import { ENGAGEMENT_STATUSES, type EngagementStatus } from "./constants";

/**
 * Whitelist a comma-separated `lifecycle_status` param. Unknown values are
 * dropped rather than rejected, matching every other filter on the contacts
 * list route (which hand-parses with regex whitelists and has no Zod).
 */
export function parseLifecycleStatuses(raw: string | null): EngagementStatus[] {
  if (!raw) return [];
  const valid = new Set<string>(ENGAGEMENT_STATUSES);
  const out = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => valid.has(s)) as EngagementStatus[];
  return [...new Set(out)];
}

/**
 * The contact's effective lifecycle status as a scalar: the stored status, or
 * 'new' when there is no contact_engagement row. That fallback is the contract
 * (db/schema.ts:4106-4108) and it is not a corner case — 122,653 of 906,082
 * production contacts had no row on 2026-09-23.
 *
 * The contacts list route selects this same expression as its column, so the
 * column and the filter below cannot disagree by construction.
 */
export function lifecycleStatusExpr(orgId: string): SQL<string> {
  return sql<string>`coalesce((
    select ce."status" from "contact_engagement" ce
    where ce."contact_id" = ${contacts.id} and ce."org_id" = ${orgId}
  ), 'new')`;
}

/**
 * A contacts-list predicate for "lifecycle status is one of these".
 *
 * Returns null when no status or every status is selected, so the caller adds
 * no predicate at all rather than a tautology the planner has to prove.
 *
 * ── WHY A SCALAR SUBQUERY AND NOT `EXISTS` ─────────────────────────────────
 * The obvious spelling is `exists (… ce.status = ANY(…))`, with a second
 * `not exists` arm so that contacts with no row still count as 'new'. It is
 * correct, and measured on production (2026-09-23) it is far too slow, because
 * Postgres is free to pull a correlated EXISTS up into a semi-join:
 *
 *   - filtering to `new`, the page query built a HASHED SubPlan over all
 *     122,653 matching contacts before it could return the first of 21 rows —
 *     1,154 ms, essentially all of it startup cost;
 *   - the capped count for `hot,warm` flipped to a nested loop driven from
 *     contact_engagement, probing contacts_pkey 10,001 times at ~0.29 ms of
 *     random I/O each — 3,673 ms.
 *
 * A correlated SCALAR subquery cannot be pulled up or hashed, so the planner
 * has to evaluate it per candidate row against contact_engagement's primary
 * key. For a 20-row page that is ~21 index probes instead of a 122K-row hash.
 *
 * It also collapses the two arms into one expression: `coalesce(status,'new')`
 * says "a missing row is new" once, rather than encoding it as an OR that the
 * next person can simplify away without noticing.
 */
export function lifecycleStatusCondition(
  orgId: string,
  statuses: EngagementStatus[],
): SQL | null {
  if (statuses.length === 0 || statuses.length === ENGAGEMENT_STATUSES.length) {
    return null;
  }
  // Values are parameterised one by one — interpolating the JS array into the
  // template would flatten it into positional params.
  return sql`${lifecycleStatusExpr(orgId)} = ANY(ARRAY[${sql.join(
    statuses.map((s) => sql`${s}`),
    sql`, `,
  )}]::text[])`;
}
