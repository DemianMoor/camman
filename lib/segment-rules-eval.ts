import "server-only";

import { and, asc, eq, sql as drizzleSql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { segment_rules } from "@/db/schema";

import { getValueShapeForRuleType } from "./validators/segment-rule-types";
import type { RuleType } from "./validators/segment-rule-types";

// A rule is "complete" — has all the inputs the eval needs — when its
// value matches the shape required by its rule_type. Incomplete FK rules
// (e.g. user changed rule_type to is_in_contact_group but hasn't picked
// a group yet) are persisted with value=null so the rule_type change
// survives tab switches; this filter excludes them from evaluation so
// they don't accidentally match-everything via NOT IN (empty set).
function isRuleComplete(rule: {
  rule_type: string;
  value: unknown;
}): boolean {
  const shape = getValueShapeForRuleType(rule.rule_type);
  if (!shape) return false;
  if (shape === "none") return rule.value == null;
  if (shape === "positive_integer") {
    return (
      typeof rule.value === "number" &&
      Number.isInteger(rule.value) &&
      rule.value >= 1
    );
  }
  return (
    typeof rule.value === "number" &&
    Number.isInteger(rule.value) &&
    rule.value >= 1
  );
}

// Build the contact_id subquery for one rule. The returned fragment is a
// parameterized "(SELECT contact_id FROM ...)" — the caller wraps it in
// `contact_id IN (...)` or `contact_id NOT IN (...)` based on operator.
function ruleInnerQuery(
  rule: {
    rule_type: string;
    operator: string;
    value: unknown;
  },
  segmentId: number,
  orgId: string,
): SQL {
  const t = rule.rule_type as RuleType;
  const v = rule.value;
  switch (t) {
    case "is_clicker_any_brand":
      return drizzleSql`SELECT contact_id FROM clickers WHERE org_id = ${orgId}::uuid`;
    case "is_clicker_for_brand":
      return drizzleSql`SELECT contact_id FROM clickers WHERE org_id = ${orgId}::uuid AND brand_id = ${Number(v)}::int`;
    case "is_clicker_for_offer":
      return drizzleSql`SELECT contact_id FROM clickers WHERE org_id = ${orgId}::uuid AND offer_id = ${Number(v)}::int`;
    case "is_optin_any_brand":
      return drizzleSql`SELECT contact_id FROM opt_ins WHERE org_id = ${orgId}::uuid`;
    case "is_optin_for_brand":
      return drizzleSql`SELECT contact_id FROM opt_ins WHERE org_id = ${orgId}::uuid AND brand_id = ${Number(v)}::int`;
    case "is_optout_for_brand":
      return drizzleSql`
        SELECT o.contact_id
        FROM opt_outs o
        JOIN opt_out_brands ob ON ob.opt_out_id = o.id
        WHERE o.org_id = ${orgId}::uuid AND ob.brand_id = ${Number(v)}::int
      `;
    case "contact_added_in_last_n_days":
      return drizzleSql`
        SELECT id AS contact_id
        FROM contacts
        WHERE org_id = ${orgId}::uuid
          AND created_at >= now() - make_interval(days => ${Number(v)})
      `;
    case "contact_added_more_than_n_days_ago":
      return drizzleSql`
        SELECT id AS contact_id
        FROM contacts
        WHERE org_id = ${orgId}::uuid
          AND created_at < now() - make_interval(days => ${Number(v)})
      `;
    case "joined_segment_in_last_n_days":
      return drizzleSql`
        SELECT contact_id
        FROM segment_contacts
        WHERE org_id = ${orgId}::uuid
          AND segment_id = ${segmentId}::int
          AND created_at >= now() - make_interval(days => ${Number(v)})
      `;
    case "joined_segment_more_than_n_days_ago":
      return drizzleSql`
        SELECT contact_id
        FROM segment_contacts
        WHERE org_id = ${orgId}::uuid
          AND segment_id = ${segmentId}::int
          AND created_at < now() - make_interval(days => ${Number(v)})
      `;
    case "member_of_segment":
      return drizzleSql`
        SELECT contact_id
        FROM segment_contacts
        WHERE org_id = ${orgId}::uuid AND segment_id = ${Number(v)}::int
      `;
    case "is_in_contact_group":
      return drizzleSql`
        SELECT contact_id
        FROM contact_contact_groups
        WHERE org_id = ${orgId}::uuid AND contact_group_id = ${Number(v)}::int
      `;
    default: {
      // Should be unreachable — server-side validation rejects unknown
      // rule_types before they ever get persisted. Defensive: return a
      // contradictory fragment so the rule matches no one.
      const _exhaustive: never = t;
      void _exhaustive;
      return drizzleSql`SELECT NULL::uuid AS contact_id WHERE false`;
    }
  }
}

// Build the SQL fragment that represents this segment's effective audience
// as a `SELECT contact_id FROM ...` subquery suitable for embedding in
// `(SELECT ... FROM (<frag>) sub)`.
//
// Semantics (Model C — UNION):
//
//   final audience =  (manual segment_contacts membership)
//                  ∪  (org contacts matching ALL active rules)
//
//   - Zero ACTIVE rules → short-circuits to manual membership only.
//     CRITICAL: any rewrite must preserve this property.
//   - 1+ active rules → UNION of manual + rule-matched contacts.
//     Rules within the segment combine via AND. `is_not` negates per-rule.
//
// Manual members are always included regardless of whether they match the
// rules — that's the difference from the prior intersection behaviour.
//
// Caller wraps this in a CTE or subquery as needed.
export async function buildSegmentAudienceClause(
  segmentId: number,
  orgId: string,
): Promise<SQL> {
  const allRules = await db
    .select({
      rule_type: segment_rules.rule_type,
      operator: segment_rules.operator,
      value: segment_rules.value,
    })
    .from(segment_rules)
    .where(
      and(
        eq(segment_rules.segment_id, segmentId),
        eq(segment_rules.org_id, orgId),
        eq(segment_rules.is_active, true),
      ),
    )
    .orderBy(asc(segment_rules.position));

  // Skip incomplete rules — see isRuleComplete above. The same short-circuit
  // applies whether the segment has no rules OR only incomplete rules:
  // audience = manual.
  const rules = allRules.filter(isRuleComplete);

  // Zero-rule short-circuit: identical to pre-rules behavior — manual only.
  // Tested explicitly in scripts/test-segment-rules-api.ts.
  if (rules.length === 0) {
    return drizzleSql`
      SELECT sc.contact_id
      FROM segment_contacts sc
      WHERE sc.segment_id = ${segmentId}::int
        AND sc.org_id = ${orgId}::uuid
    `;
  }

  // Build per-rule predicates that reference `c.id` (the outer contacts
  // alias of the rule_matches scan). Each rule becomes a `c.id IN (...)`
  // or `c.id NOT IN (...)` test. Rules combine via AND.
  const conditions = rules.map((r) => {
    const inner = ruleInnerQuery(r, segmentId, orgId);
    return r.operator === "is_not"
      ? drizzleSql`c.id NOT IN (${inner})`
      : drizzleSql`c.id IN (${inner})`;
  });
  const joined = conditions.reduce(
    (acc, cnd, i) => (i === 0 ? cnd : drizzleSql`${acc} AND ${cnd}`),
  );

  // UNION ALL + DISTINCT is cheaper than UNION when overlaps are few, but
  // UNION suffices here (Postgres collapses duplicates implicitly). We
  // could switch to UNION ALL + an outer SELECT DISTINCT if profiling shows
  // overlap-heavy workloads dominating, but the planner currently chooses
  // sensibly for both shapes.
  return drizzleSql`
    SELECT contact_id FROM (
      SELECT sc.contact_id AS contact_id
      FROM segment_contacts sc
      WHERE sc.segment_id = ${segmentId}::int
        AND sc.org_id = ${orgId}::uuid
      UNION
      SELECT c.id AS contact_id
      FROM contacts c
      WHERE c.org_id = ${orgId}::uuid
        AND (${joined})
    ) AS combined
  `;
}

// Helper for the rules preview endpoint and refresh-stats endpoint:
// runs the audience clause with a hard statement_timeout, returns the
// count or null on timeout.
export async function previewSegmentAudienceCount(
  segmentId: number,
  orgId: string,
  timeoutMs = 10_000,
): Promise<{ count: number | null; truncated: boolean; durationMs: number }> {
  const clause = await buildSegmentAudienceClause(segmentId, orgId);
  const start = Date.now();
  try {
    // SET LOCAL statement_timeout ... runs only inside this transaction.
    const result = await db.transaction(async (tx) => {
      // SET LOCAL doesn't accept bound params — inline via raw, after
      // coercing to a clean positive integer.
      const ms = Math.max(1, Math.floor(timeoutMs));
      await tx.execute(
        drizzleSql.raw(`SET LOCAL statement_timeout = ${ms}`),
      );
      const rows = (await tx.execute(
        drizzleSql`SELECT count(*)::int AS count FROM (${clause}) sub`,
      )) as unknown as { count: number }[];
      return rows[0]?.count ?? 0;
    });
    return {
      count: result,
      truncated: false,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    // Postgres throws code 57014 (query_canceled) on statement_timeout.
    if (msg.includes("statement timeout") || msg.includes("57014")) {
      return { count: null, truncated: true, durationMs };
    }
    throw err;
  }
}
