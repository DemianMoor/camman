import "server-only";

import { and, asc, eq, sql as drizzleSql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { dripInUseSubquery, isDripPostureOn } from "@/lib/drip/in-use";
import { isStatementTimeout } from "@/lib/db/statement-timeout";
import { purchasedClause } from "@/lib/sale-attribution";
import { segment_rules, segments } from "@/db/schema";

import {
  AGE_BAND_BOUNDS,
  AGE_BAND_VALUES,
  CARRIER_VALUES,
  GENDER_VALUES,
  getValueShapeForRuleType,
  INCOME_BAND_VALUES,
  isCampaignUsePeriod,
  isProviderPhoneSet,
  isStringSubsetOf,
  isTextSet,
  PHONE_TYPE_VALUES,
  YES_NO_VALUES,
} from "./validators/segment-rule-types";
import type {
  AgeBandValue,
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
  // Set shapes hold arrays/objects, not numbers — without these the fall-through
  // below silently drops every phone_type / carrier / sent_from_provider_phone
  // rule from evaluation.
  if (shape === "phone_type_set") {
    return isStringSubsetOf(rule.value, PHONE_TYPE_VALUES);
  }
  if (shape === "carrier_set") {
    return isStringSubsetOf(rule.value, CARRIER_VALUES);
  }
  if (shape === "provider_phone_set") {
    return isProviderPhoneSet(rule.value);
  }
  // contact_attributes sets (0147). Same trap as above: without these the
  // numeric fall-through rejects every one of them, the rule is treated as
  // INCOMPLETE and silently dropped from evaluation — and under EXCEPT a
  // dropped `is_not` rule turns "nobody" into "EVERYBODY". This test must stay
  // identical-or-stronger than what the emitter accepts.
  if (shape === "gender_set") {
    return isStringSubsetOf(rule.value, GENDER_VALUES);
  }
  if (shape === "age_band_set") {
    return isStringSubsetOf(rule.value, AGE_BAND_VALUES);
  }
  if (shape === "income_band_set") {
    return isStringSubsetOf(rule.value, INCOME_BAND_VALUES);
  }
  if (shape === "yes_no_set") {
    return isStringSubsetOf(rule.value, YES_NO_VALUES);
  }
  if (shape === "text_set") {
    return isTextSet(rule.value);
  }
  return (
    typeof rule.value === "number" &&
    Number.isInteger(rule.value) &&
    rule.value >= 1
  );
}

// Postgres text[] literal from a validated string set (single-quote escaped).
// Empty → ARRAY[]::text[] (matches nothing — defensive; validation requires ≥1).
function textArrayLiteral(values: string[]): string {
  if (values.length === 0) return "ARRAY[]::text[]";
  return (
    "ARRAY[" + values.map((v) => `'${v.replace(/'/g, "''")}'`).join(",") + "]::text[]"
  );
}

// Postgres int[] literal from a validated id list. Values are integers that
// already passed isProviderPhoneSet, so there is nothing to escape; Math.trunc
// is belt-and-braces before the value reaches drizzleSql.raw.
function intArrayLiteral(values: number[]): string {
  if (values.length === 0) return "ARRAY[]::int[]";
  return "ARRAY[" + values.map((n) => String(Math.trunc(n))).join(",") + "]::int[]";
}

// Build the contact_id subquery for one rule. The returned fragment is a
// parameterized "SELECT contact_id FROM ..." — the caller combines it with
// the running result via SQL set arithmetic (UNION / INTERSECT / EXCEPT),
// not by wrapping it in `contact_id IN (...)` / `NOT IN (...)` — see
// ruleSet/combinedOp/operandFor in buildSegmentAudienceClause below.
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
    case "made_purchase":
      // A buyer: ≥1 send row carrying a non-rejected conversion. `purchasedClause`
      // is the shared definition — see lib/sale-attribution.ts for why this is
      // NOT `sale_status = 'sale'` (the network pays out on `lead` postbacks).
      // DISTINCT because a contact can have many send rows. Partial index
      // stage_sends_sale_status_idx.
      return drizzleSql`SELECT DISTINCT ss.contact_id FROM stage_sends ss WHERE ss.org_id = ${orgId}::uuid AND ${purchasedClause()}`;
    case "made_purchase_for_brand":
      // Brand scope: join to the campaign that owns the send. brand lives on
      // campaigns, not stage_sends.
      return drizzleSql`
        SELECT DISTINCT ss.contact_id
        FROM stage_sends ss
        JOIN campaigns ca ON ca.id = ss.campaign_id
        WHERE ss.org_id = ${orgId}::uuid
          AND ${purchasedClause()}
          AND ca.brand_id = ${Number(v)}::int
      `;
    case "made_purchase_for_offer":
      return drizzleSql`
        SELECT DISTINCT ss.contact_id
        FROM stage_sends ss
        JOIN campaigns ca ON ca.id = ss.campaign_id
        WHERE ss.org_id = ${orgId}::uuid
          AND ${purchasedClause()}
          AND ca.offer_id = ${Number(v)}::int
      `;
    case "reached_offer":
      // Reached the offer page: ≥1 send row stamped offer_reached_at. DISTINCT
      // because a contact can have many send rows. Empty until real sends
      // accumulate. Partial index stage_sends_offer_reached_at_idx.
      return drizzleSql`SELECT DISTINCT contact_id FROM stage_sends WHERE org_id = ${orgId}::uuid AND offer_reached_at IS NOT NULL`;
    case "reached_offer_for_brand":
      return drizzleSql`
        SELECT DISTINCT ss.contact_id
        FROM stage_sends ss
        JOIN campaigns ca ON ca.id = ss.campaign_id
        WHERE ss.org_id = ${orgId}::uuid
          AND ss.offer_reached_at IS NOT NULL
          AND ca.brand_id = ${Number(v)}::int
      `;
    case "reached_offer_for_offer":
      return drizzleSql`
        SELECT DISTINCT ss.contact_id
        FROM stage_sends ss
        JOIN campaigns ca ON ca.id = ss.campaign_id
        WHERE ss.org_id = ${orgId}::uuid
          AND ss.offer_reached_at IS NOT NULL
          AND ca.offer_id = ${Number(v)}::int
      `;
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
      // messaging_status literal (NOT a bind) so the planner matches the partial
      // index contacts_org_created_eligible_idx. Migration 0096.
      return drizzleSql`
        SELECT id AS contact_id
        FROM contacts
        WHERE org_id = ${orgId}::uuid
          AND messaging_status = 'eligible'
          AND created_at >= now() - make_interval(days => ${Number(v)})
      `;
    case "contact_added_more_than_n_days_ago":
      return drizzleSql`
        SELECT id AS contact_id
        FROM contacts
        WHERE org_id = ${orgId}::uuid
          AND messaging_status = 'eligible'
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
    case "in_use_in_offer": {
      // Contacts snapshotted into a campaign for the selected offer that still
      // counts as "in use": campaign ran (status active/paused/completed — not
      // draft, not archived) AND still has ≥1 live stage. "Live" = a stage in
      // draft/pending/sent/success; if every stage is cancelled/failed/archived
      // (or there are none) the campaign has released its contacts. Same
      // live-campaign definition as in_use_in_campaign_last_period, scoped by
      // offer instead of a time window.
      return drizzleSql`
        SELECT DISTINCT p.contact_id
        FROM campaign_audience_pool p
        JOIN campaigns ca ON ca.id = p.campaign_id
        WHERE p.org_id = ${orgId}::uuid
          AND ca.org_id = ${orgId}::uuid
          AND ca.status IN ('active', 'paused', 'completed')
          AND ca.offer_id = ${Number(v)}::int
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
    case "phone_type": {
      // Set membership over the eligible-partial-indexed line_type. messaging_status
      // literal → uses contacts_org_linetype_eligible_idx (migration 0096).
      const set = Array.isArray(v) ? (v as string[]) : [];
      return drizzleSql`
        SELECT id AS contact_id FROM contacts
        WHERE org_id = ${orgId}::uuid AND messaging_status = 'eligible'
          AND line_type = ANY(${drizzleSql.raw(textArrayLiteral(set))})
      `;
    }
    case "carrier": {
      // 'Unknown' expands to ('Unknown','Unmapped') (Unmapped groups with Unknown);
      // 'Unidentified' matches only itself. Uses contacts_org_carrier_eligible_idx.
      const set = Array.isArray(v) ? (v as string[]) : [];
      const expanded = set.flatMap((c) =>
        c === "Unknown" ? ["Unknown", "Unmapped"] : [c],
      );
      return drizzleSql`
        SELECT id AS contact_id FROM contacts
        WHERE org_id = ${orgId}::uuid AND messaging_status = 'eligible'
          AND carrier_norm = ANY(${drizzleSql.raw(textArrayLiteral(expanded))})
      `;
    }
    case "sent_from_provider_phone": {
      // Which of OUR numbers messaged the contact. status='sent' is the
      // codebase-wide "accepted by the provider" definition (lib/reporting/
      // rollup.ts et al) — counting pending/rejected/filtered would disagree
      // with /reports for the same number. Written as a literal, not a bind,
      // so the planner can match the partial index
      // stage_sends_org_provider_phone_sent_idx (same technique as
      // contact_added_in_last_n_days). provider_id is not used here: it is
      // implied by the phone ids and enforced at write time by
      // verifyValueOwnership.
      const set = isProviderPhoneSet(v) ? v : { provider_id: 0, phone_ids: [] };
      return drizzleSql`
        SELECT DISTINCT contact_id FROM stage_sends
        WHERE org_id = ${orgId}::uuid
          AND status = 'sent'
          AND provider_phone_id = ANY(${drizzleSql.raw(intArrayLiteral(set.phone_ids))})
      `;
    }
    // ── contact_attributes (0147) ────────────────────────────────────────
    // All nine share one shape: a bare `SELECT contact_id` joined to contacts
    // for the eligible gate, so the set-arithmetic combiner can INTERSECT /
    // EXCEPT it exactly like every other rule.
    //
    // ⚠️ A contact with NO attributes row matches NONE of these. That is the
    // whole reason `is_not` stays conservative: under EXCEPT, `is_not gender
    // is male` removes only people we positively know are male — it does not
    // sweep in the ~815K contacts we know nothing about.
    case "gender":
      return attributeSetClause(orgId, "gender", isStringSubsetOf(v, GENDER_VALUES) ? v : []);
    case "income_band":
      return attributeSetClause(orgId, "income_band", isStringSubsetOf(v, INCOME_BAND_VALUES) ? v : []);
    case "contact_state":
      return attributeSetClause(orgId, "state", isTextSet(v) ? v : []);
    case "contact_country":
      return attributeSetClause(orgId, "country", isTextSet(v) ? v : []);
    case "interest_tag":
      return attributeSetClause(orgId, "interest_tag", isTextSet(v) ? v : []);
    case "partner_slug":
      return attributeSetClause(orgId, "partner_slug", isTextSet(v) ? v : []);
    case "has_kids":
      return attributeBoolClause(orgId, "kids", isStringSubsetOf(v, YES_NO_VALUES) ? v : []);
    case "is_married":
      return attributeBoolClause(orgId, "married", isStringSubsetOf(v, YES_NO_VALUES) ? v : []);
    case "age_band": {
      // ⚠️ NEVER a per-row age(): the band is turned into a RANGE on dob so
      // contact_attributes_org_dob_idx applies. See ageBandClause.
      const bands = isStringSubsetOf(v, AGE_BAND_VALUES) ? (v as AgeBandValue[]) : [];
      return ageBandClause(orgId, bands);
    }
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

// ── contact_attributes emitter helpers (0147) ────────────────────────────────
//
// Shared shape for every attribute rule. The JOIN to contacts applies the
// eligible gate, matching what phone_type / carrier do — a landline must not
// reappear through an attribute rule. It costs one PK lookup per row.
//
// The column name is interpolated with drizzleSql.raw and therefore must NEVER
// come from user input: every call site passes a hard-coded literal below.
function attributeBase(orgId: string): SQL {
  return drizzleSql`
    FROM contact_attributes ca
    JOIN contacts c ON c.id = ca.contact_id
    WHERE ca.org_id = ${orgId}::uuid
      AND c.messaging_status = 'eligible'`;
}

// Set membership over a TEXT attribute column. An empty set yields a
// contradiction rather than matching everything — an incomplete rule must
// never widen an audience (isRuleComplete already drops it upstream; this is
// defense in depth for the same invariant).
function attributeSetClause(orgId: string, column: string, set: readonly string[]): SQL {
  if (set.length === 0) return drizzleSql`SELECT NULL::uuid AS contact_id WHERE false`;
  return drizzleSql`
    SELECT ca.contact_id ${attributeBase(orgId)}
      AND ca.${drizzleSql.raw(column)} = ANY(${drizzleSql.raw(textArrayLiteral([...set]))})
  `;
}

// yes/no set over a BOOLEAN column. Selecting BOTH means "known either way",
// which still excludes NULL (unknown) — the intended reading, and the reason
// this is a set rather than a tri-state.
function attributeBoolClause(orgId: string, column: string, set: readonly string[]): SQL {
  const wants: boolean[] = [];
  if (set.includes("yes")) wants.push(true);
  if (set.includes("no")) wants.push(false);
  if (wants.length === 0) return drizzleSql`SELECT NULL::uuid AS contact_id WHERE false`;
  const literal = `ARRAY[${wants.map((b) => (b ? "true" : "false")).join(",")}]::boolean[]`;
  return drizzleSql`
    SELECT ca.contact_id ${attributeBase(orgId)}
      AND ca.${drizzleSql.raw(column)} = ANY(${drizzleSql.raw(literal)})
  `;
}

// ── Age bands ───────────────────────────────────────────────────────────────
//
// ⚠️ THE BAND IS A RANGE ON dob, NEVER A PER-ROW AGE.
//
//   ✗ EXTRACT(YEAR FROM age(ca.dob)) BETWEEN 25 AND 34
//       a function of dob and now() evaluated per row — not sargable, so
//       contact_attributes_org_dob_idx can never be used.
//   ✓ ca.dob > <ET today> - INTERVAL '35 years'
//     AND ca.dob <= <ET today> - INTERVAL '25 years'
//
// Same technique as the per-carrier daily cap (migration 0143), which passes an
// ET day as a timestamptz RANGE rather than applying a function to sent_at.
//
// The anchor is the ET CALENDAR DATE, matching the rest of the send path, not
// the server's UTC date.
//
// ⚠️ THE 18-YEAR FLOOR IS APPLIED INDEPENDENTLY of the selected bands. It is
// redundant with the band ranges today (the lowest band starts at 18) and that
// is deliberate: a future band edit cannot lower it, and it is one line to
// audit. It also does the NULL work for free — `NULL <= date` is NULL, not
// true, so an unknown dob matches nothing without a separate IS NOT NULL.
//
// Scope note: this is the age_band RULE's floor, not a global minor gate.
// A global "unknown dob = minor" filter would exclude every contact that has no
// attributes row at all — see docs/03-data-model.md and the P2/P3 cards.
const ET_TODAY = `(now() AT TIME ZONE 'America/New_York')::date`;

function ageBandClause(orgId: string, bands: readonly AgeBandValue[]): SQL {
  if (bands.length === 0) return drizzleSql`SELECT NULL::uuid AS contact_id WHERE false`;
  // age >= minAge  ⇔  dob <= ET_today - minAge years
  // age <= maxAge  ⇔  dob >  ET_today - (maxAge + 1) years
  const ranges = bands.map((b) => {
    const { minAge, maxAge } = AGE_BAND_BOUNDS[b];
    const upper = `ca.dob <= ${ET_TODAY} - INTERVAL '${minAge} years'`;
    if (maxAge === null) return `(${upper})`;
    return `(${upper} AND ca.dob > ${ET_TODAY} - INTERVAL '${maxAge + 1} years')`;
  });
  return drizzleSql`
    SELECT ca.contact_id ${attributeBase(orgId)}
      AND ca.dob <= ${drizzleSql.raw(ET_TODAY)} - INTERVAL '18 years'
      AND (${drizzleSql.raw(ranges.join(" OR "))})
  `;
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
// `restrictUniverse` (optional): a `SELECT contact_id …` clause that replaces
// "all org contacts" as the universe for `is_not` complements. When the caller
// already knows the result will be INTERSECTed with a small set (e.g. the
// campaign's contact-group side), passing that set here keeps the negation
// `(universe EXCEPT inner)` from materializing the entire contacts table —
// a major perf win, since `is_not` on a near-universal rule otherwise scans
// and sorts ~all contacts. Correctness is unchanged: the caller's outer
// INTERSECT against the same set already constrains the result, so narrowing
// the is_not base to that set can only drop rows the INTERSECT would drop
// anyway.
//
// Caller wraps this in a CTE or subquery as needed.
export async function buildSegmentAudienceClause(
  segmentId: number,
  orgId: string,
  restrictUniverse?: SQL,
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
  // Posture read once; false ⇒ pre-Phase-4 SQL, byte for byte.
  const dripPostureOn = excludeInUse ? await isDripPostureOn(orgId) : false;

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
  //
  // ⚠️ THE DRIP BRANCH MUST MATCH THE CAMPAIGN-LEVEL DEFINITION (ruling G2).
  // There are two independent in-use definitions — this one (the per-segment
  // flag) and `iu_set` in lib/audience-snapshot.ts (the campaign-level flag).
  // Before drip they agreed by coincidence. Adding drip journeys to only one
  // would give two different answers to "is this contact in use?" from one
  // product, so both call the SAME builder in lib/drip/in-use.ts, and it is
  // emitted only when drip posture is on — with posture off this function
  // produces exactly the SQL it produced before Phase 4.
  function applyInUseExclusion(audience: SQL): SQL {
    if (!excludeInUse) return audience;
    const drip = dripInUseSubquery(orgId, dripPostureOn);
    const dripBranch = drip
      ? drizzleSql`
      EXCEPT
      ${drip}`
      : drizzleSql``;
    return drizzleSql`
      ${audience}
      EXCEPT
      SELECT p.contact_id
      FROM campaign_audience_pool p
      INNER JOIN campaigns ca ON ca.id = p.campaign_id
      WHERE p.org_id = ${orgId}::uuid
        AND ca.org_id = ${orgId}::uuid
        AND ca.status = 'active'${dripBranch}
    `;
  }

  // Landline hard stop (migration 0096/0099): drop any contact_id that isn't
  // messaging_status='eligible'. This is the correctness backstop for the whole
  // segment audience — it catches landlines that enter via MANUAL membership
  // (segment_contacts) or non-contacts rules (clickers, opt-ins, …), which the
  // is_not/contact_added scan gates alone can't reach. messaging_status is a
  // LITERAL (not a bind). Gating here (not per-consumer) means preview, snapshot,
  // and every draft count share the exact same eligible audience.
  function gateEligible(audience: SQL): SQL {
    return drizzleSql`
      SELECT elig_s.contact_id
      FROM (${audience}) elig_s
      INNER JOIN contacts elig_c
        ON elig_c.id = elig_s.contact_id
        AND elig_c.org_id = ${orgId}::uuid
        AND elig_c.messaging_status = 'eligible'
    `;
  }

  // Zero-rule short-circuit: identical to pre-rules behavior — manual only.
  // Tested explicitly in scripts/test-segment-rules-api.ts.
  if (rules.length === 0) {
    return gateEligible(applyInUseExclusion(drizzleSql`
      SELECT sc.contact_id
      FROM segment_contacts sc
      WHERE sc.segment_id = ${segmentId}::int
        AND sc.org_id = ${orgId}::uuid
    `));
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
  // The universe for an `is_not` complement: either the full org contacts
  // table or the caller-supplied restriction (see the doc comment above).
  // messaging_status literal (NOT a bind) so the full-contacts negation universe
  // uses the partial index contacts_org_eligible_idx (migration 0096) and never
  // materializes landlines. When restrictUniverse is the group set, that set is
  // already eligible-gated (buildGroupMembershipClause). Either way the segment
  // audience excludes landlines; the output gate below is the correctness backstop.
  const universeBase = restrictUniverse
    ? drizzleSql`SELECT contact_id FROM (${restrictUniverse}) ru_universe`
    : drizzleSql`SELECT id AS contact_id FROM contacts WHERE org_id = ${orgId}::uuid AND messaging_status = 'eligible'`;

  function ruleSet(rule: (typeof rules)[number]): SQL {
    const inner = ruleInnerQuery(rule, segmentId, orgId);
    if (rule.operator !== "is_not") return inner;
    return drizzleSql`
      ${universeBase}
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
  return gateEligible(applyInUseExclusion(drizzleSql`
    SELECT contact_id FROM (
      SELECT sc.contact_id AS contact_id
      FROM segment_contacts sc
      WHERE sc.segment_id = ${segmentId}::int
        AND sc.org_id = ${orgId}::uuid
      UNION
      (${ruleMatches})
    ) AS combined
  `));
}

// Drop opt-outs from a segment audience clause (which is always a plain
// `SELECT contact_id …` — see gateEligible). SEGMENT-PAGE READ PATHS ONLY.
//
// Why not inside buildSegmentAudienceClause: the campaign audience path
// deliberately keeps opt-outs in its source set so `previewAudience` can
// report `excluded_for_optout` before stripping them in `qualifies`, and the
// snapshot path already anti-joins them once against a temp table with real
// row stats. Folding an extra anti-join into every segment branch would
// duplicate that work in the perf-critical activation path for no gain.
//
// Applying it here makes the segment page report the same SENDABLE audience a
// campaign draws from. Without it the page shows a figure no campaign can ever
// reach — opt-outs are never sendable — which read as ~10K contacts silently
// disappearing between the segment page and the campaign form.
export function excludeOptOutsFromAudience(audience: SQL, orgId: string): SQL {
  return drizzleSql`
    SELECT oo_a.contact_id
    FROM (${audience}) oo_a
    WHERE NOT EXISTS (
      SELECT 1 FROM opt_outs oo
      WHERE oo.contact_id = oo_a.contact_id
        AND oo.org_id = ${orgId}::uuid
    )
  `;
}

export interface SegmentAudienceCounts {
  /**
   * The SENDABLE audience — full audience minus opt-outs. This is the figure
   * the segment page shows, and it reconciles with a campaign's "From
   * segments". Null on timeout.
   */
  count: number | null;
  /** Full audience (manual ∪ rule matches) BEFORE opt-out suppression. */
  total: number | null;
  /**
   * Engagement counters over the FULL audience (one consistent basis, so
   * `count` + `opt_out_count` = `total`). Null on timeout. These replace the
   * older manual-membership-only counters, which read 0 for every rule-based
   * segment — a segment literally named "Clickers …" reported `Clickers 0`.
   */
  opt_out_count: number | null;
  opt_in_count: number | null;
  clicker_count: number | null;
  truncated: boolean;
  durationMs: number;
}

// Helper for the rules preview endpoint and refresh-stats endpoint: runs the
// audience clause with a hard statement_timeout and returns the sendable count
// plus the engagement counters, or nulls on timeout. One pass over the audience
// — the status sets are deduped into CTEs and LEFT JOINed (hash joins) rather
// than probed per row with correlated EXISTS, matching the campaign preview's
// flagSetCtes/flagJoins shape.
export async function previewSegmentAudienceCount(
  segmentId: number,
  orgId: string,
  timeoutMs = 10_000,
): Promise<SegmentAudienceCounts> {
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
      const rows = (await tx.execute(drizzleSql`
        with audience as (${clause}),
        oo_set as (select distinct contact_id from opt_outs where org_id = ${orgId}::uuid),
        oi_set as (select distinct contact_id from opt_ins where org_id = ${orgId}::uuid),
        cl_set as (select distinct contact_id from clickers where org_id = ${orgId}::uuid)
        select
          count(*)::int as total,
          count(*) filter (where oo_set.contact_id is null)::int as count,
          count(*) filter (where oo_set.contact_id is not null)::int as opt_out_count,
          count(*) filter (where oi_set.contact_id is not null)::int as opt_in_count,
          count(*) filter (where cl_set.contact_id is not null)::int as clicker_count
        from audience a
        left join oo_set on oo_set.contact_id = a.contact_id
        left join oi_set on oi_set.contact_id = a.contact_id
        left join cl_set on cl_set.contact_id = a.contact_id
      `)) as unknown as {
        total: number;
        count: number;
        opt_out_count: number;
        opt_in_count: number;
        clicker_count: number;
      }[];
      return Array.isArray(rows) ? rows[0] : null;
    });
    return {
      count: result?.count ?? 0,
      total: result?.total ?? 0,
      opt_out_count: result?.opt_out_count ?? 0,
      opt_in_count: result?.opt_in_count ?? 0,
      clicker_count: result?.clicker_count ?? 0,
      truncated: false,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    // Postgres throws code 57014 (query_canceled) on statement_timeout; it
    // lives on err.cause (drizzle wraps the driver error), so detect it via the
    // cause chain — a message-only check re-throws a timeout we mean to degrade.
    if (isStatementTimeout(err)) {
      return {
        count: null,
        total: null,
        opt_out_count: null,
        opt_in_count: null,
        clicker_count: null,
        truncated: true,
        durationMs,
      };
    }
    throw err;
  }
}
