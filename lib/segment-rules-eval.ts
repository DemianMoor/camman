import "server-only";

import { and, asc, eq, sql as drizzleSql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { segment_rules, segments } from "@/db/schema";

import {
  getValueShapeForRuleType,
  isCampaignUsePeriod,
} from "./validators/segment-rule-types";
import type {
  CampaignUsePeriod,
  RuleType,
} from "./validators/segment-rule-types";

// Code → SQL interval for the "in use in another campaign" lookback window.
// Kept server-side: the wire/persisted form is only the opaque code. Built
// with make_interval so the units are explicit (weeks/months/years, not a
// flattened day count) and DST/calendar math is Postgres's job.
const CAMPAIGN_USE_PERIOD_INTERVAL: Record<CampaignUsePeriod, SQL> = {
  "1d": drizzleSql`make_interval(days => 1)`,
  "3d": drizzleSql`make_interval(days => 3)`,
  "1w": drizzleSql`make_interval(weeks => 1)`,
  "2w": drizzleSql`make_interval(weeks => 2)`,
  "1m": drizzleSql`make_interval(months => 1)`,
  "3m": drizzleSql`make_interval(months => 3)`,
  "6m": drizzleSql`make_interval(months => 6)`,
  "1y": drizzleSql`make_interval(years => 1)`,
};

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
  if (shape === "campaign_use_period") return isCampaignUsePeriod(rule.value);
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
    case "in_use_in_campaign_last_period": {
      // Contacts already snapshotted into a campaign that ran within the
      // lookback window AND still has a live stage. "Live" = a stage in
      // draft/pending/sent/success; if every stage is cancelled/failed (or
      // there are none) the campaign has released its contacts and they no
      // longer count as in use. Window anchors on campaigns.created_at.
      // Campaign status restricted to active/paused/completed ("any that
      // ran" — draft has no pool rows; archived is excluded by design).
      const interval = CAMPAIGN_USE_PERIOD_INTERVAL[v as CampaignUsePeriod];
      return drizzleSql`
        SELECT DISTINCT p.contact_id
        FROM campaign_audience_pool p
        JOIN campaigns ca ON ca.id = p.campaign_id
        WHERE p.org_id = ${orgId}::uuid
          AND ca.org_id = ${orgId}::uuid
          AND ca.status IN ('active', 'paused', 'completed')
          AND ca.created_at >= now() - ${interval}
          AND EXISTS (
            SELECT 1
            FROM campaign_stages s
            WHERE s.campaign_id = ca.id
              AND s.org_id = ${orgId}::uuid
              AND s.status IN ('draft', 'pending', 'sent', 'success')
          )
      `;
    }
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
// Semantics (Model C — UNION + per-rule combinator):
//
//   final audience =  (manual segment_contacts membership)
//                  ∪  (org contacts matching the per-rule combinator chain)
//
//   - Zero ACTIVE rules → short-circuits to manual membership only.
//     CRITICAL: any rewrite must preserve this property.
//   - 1+ active rules → UNION of manual + rule-matched contacts.
//     Rules combine left-to-right by `combinator`: rule N joins to the
//     running result with `AND` or `OR`. The FIRST rule's combinator is
//     ignored (no prior context to join to). `is_not` negates per-rule.
//
// Manual members are always included regardless of whether they match the
// rules — that's the difference from the prior intersection behaviour.
//
// Caller wraps this in a CTE or subquery as needed.
export async function buildSegmentAudienceClause(
  segmentId: number,
  orgId: string,
): Promise<SQL> {
  // One read to pull the segment's exclude_in_use_contacts flag alongside
  // its rules. The flag wraps the final audience clause in an EXCEPT
  // against the live in-use pool.
  const segRow = await db
    .select({ exclude_in_use: segments.exclude_in_use_contacts })
    .from(segments)
    .where(and(eq(segments.id, segmentId), eq(segments.org_id, orgId)))
    .limit(1);
  const excludeInUse = segRow[0]?.exclude_in_use === true;

  const allRules = await db
    .select({
      rule_type: segment_rules.rule_type,
      operator: segment_rules.operator,
      value: segment_rules.value,
      combinator: segment_rules.combinator,
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

  // The "in-use" pool: contacts already snapshotted into a campaign with
  // status='active'. Wrapped around the segment's audience as an EXCEPT
  // when the segment's exclude_in_use_contacts flag is on. Note we read
  // from campaign_audience_pool directly; that table holds frozen
  // snapshots independent of opt-out activity.
  function applyInUseExclusion(audience: SQL): SQL {
    if (!excludeInUse) return audience;
    return drizzleSql`
      ${audience}
      EXCEPT
      SELECT p.contact_id
      FROM campaign_audience_pool p
      INNER JOIN campaigns ca ON ca.id = p.campaign_id
      WHERE p.org_id = ${orgId}::uuid
        AND ca.org_id = ${orgId}::uuid
        AND ca.status = 'active'
    `;
  }

  // Zero-rule short-circuit: identical to pre-rules behavior — manual only.
  // Tested explicitly in scripts/test-segment-rules-api.ts.
  if (rules.length === 0) {
    return applyInUseExclusion(drizzleSql`
      SELECT sc.contact_id
      FROM segment_contacts sc
      WHERE sc.segment_id = ${segmentId}::int
        AND sc.org_id = ${orgId}::uuid
    `);
  }

  // Combine rules via SQL set arithmetic (UNION / INTERSECT / EXCEPT) so
  // each rule's subquery can pick its own optimal index plan. Mapping:
  //
  //   AND with "is"      → INTERSECT  (running ∩ inner)
  //   OR  with "is"      → UNION      (running ∪ inner)
  //   AND with "is_not"  → EXCEPT     (running ∖ inner)
  //   OR  with "is_not"  → UNION  (running ∪ (all_contacts ∖ inner))   *
  //
  //   * The OR-is_not case expands the negation to "all org contacts
  //     except inner" before UNION-ing — full table scan on contacts.
  //     Rare path (the UI defaults each rule to "is" + combinator=and),
  //     but correct.
  //
  // The first rule has no prior context: its combinator is ignored, and
  // we seed `running` from it directly. For a first rule with operator
  // "is_not", the seed becomes (all_contacts ∖ inner).
  //
  // Left-associative — `(R1 OP2 R2) OP3 R3 …` — so we wrap each step in
  // parens. (Postgres gives INTERSECT higher precedence than UNION/EXCEPT
  // by default; the parens force left-to-right regardless.)
  function ruleSet(rule: (typeof rules)[number]): SQL {
    const inner = ruleInnerQuery(rule, segmentId, orgId);
    if (rule.operator !== "is_not") return inner;
    return drizzleSql`
      SELECT id AS contact_id FROM contacts WHERE org_id = ${orgId}::uuid
      EXCEPT
      ${inner}
    `;
  }

  function combinedOp(rule: (typeof rules)[number]): string {
    // Operator + combinator → set operator.
    // is_not + AND → EXCEPT; otherwise drop is_not into UNION via ruleSet.
    if (rule.operator === "is_not" && rule.combinator !== "or") {
      return "EXCEPT";
    }
    return rule.combinator === "or" ? "UNION" : "INTERSECT";
  }

  // For EXCEPT we want the inner subquery directly (so EXCEPT subtracts it),
  // not its negation. For all other ops we want the rule's matched set
  // (which already handles is_not by EXCEPT-expansion).
  function operandFor(rule: (typeof rules)[number]): SQL {
    if (rule.operator === "is_not" && rule.combinator !== "or") {
      return ruleInnerQuery(rule, segmentId, orgId);
    }
    return ruleSet(rule);
  }

  const ruleMatches = rules.reduce<SQL>((acc, rule, i) => {
    if (i === 0) return ruleSet(rule);
    const op = combinedOp(rule);
    const next = operandFor(rule);
    return drizzleSql`(${acc}) ${drizzleSql.raw(op)} (${next})`;
  }, drizzleSql``);

  // Manual membership ∪ rule-matched. UNION dedupes; UNION ALL would be
  // cheaper but the dedup is needed when a manual member also matches a
  // rule (otherwise the count is inflated).
  return applyInUseExclusion(drizzleSql`
    SELECT contact_id FROM (
      SELECT sc.contact_id AS contact_id
      FROM segment_contacts sc
      WHERE sc.segment_id = ${segmentId}::int
        AND sc.org_id = ${orgId}::uuid
      UNION
      (${ruleMatches})
    ) AS combined
  `);
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
