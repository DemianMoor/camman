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
 * A contacts-list predicate for "lifecycle status is one of these".
 *
 * Reads `contacts.lifecycle_status` — the projection migration 0188 added and
 * lib/engagement/refresh.ts maintains. That column is NOT NULL with default
 * 'new', so the "a contact the job has never seen is new" contract is carried
 * by the column itself and needs no `coalesce` or `NOT EXISTS` arm here.
 *
 * Before 0188 this had to reach into contact_engagement, and no spelling of it
 * was fast: the list sorts by created_at while status lived in another table,
 * so the planner walked contacts testing rows (measured on production: freeze
 * 3,931 ms, suppressed 13,413 ms against a 300 ms bar). With the column and
 * `contacts_org_lifecycle_created_idx (org_id, lifecycle_status, created_at
 * DESC)` it is an index range scan.
 *
 * Returns null when no status or every status is selected, so the caller adds
 * no predicate at all rather than a tautology the planner has to prove.
 */
export function lifecycleStatusCondition(statuses: EngagementStatus[]): SQL | null {
  if (statuses.length === 0 || statuses.length === ENGAGEMENT_STATUSES.length) {
    return null;
  }
  // ONE status is emitted as plain equality, not a one-element ANY(). That is
  // not cosmetic. `= ANY(ARRAY[…])` is a ScalarArrayOpExpr, and an index scan
  // under one cannot promise its rows in index order, so the planner will not
  // use contacts_org_lifecycle_created_idx to satisfy `ORDER BY created_at DESC
  // LIMIT 21` — it falls back to scanning contacts_org_id_created_at_idx and
  // filtering. Measured on production for `freeze`: 852 ms, having discarded
  // 236,215 rows, because it assumes matches are spread evenly along created_at
  // and they are not (freeze contacts are the old ones). Plain equality lets the
  // composite index provide both the match and the ordering.
  const values = statuses.map((s) => sql`${s}`);
  return values.length === 1
    ? sql`${contacts.lifecycle_status} = ${statuses[0]}`
    : // Values are parameterised one by one — interpolating the JS array into
      // the template would flatten it into positional params.
      sql`${contacts.lifecycle_status} = ANY(ARRAY[${sql.join(values, sql`, `)}]::text[])`;
}
