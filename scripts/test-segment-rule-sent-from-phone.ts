// Validator + ownership + eval assertions for the sent_from_provider_phone
// segment rule. Run: npx tsx --conditions=react-server scripts/test-segment-rule-sent-from-phone.ts
// MUST be first: ESM hoists all imports above any statement, so a config()
// call written here would still run AFTER db/client has read DATABASE_URL —
// which surfaces as `password authentication failed for user "dimat"` (the
// driver falling back to the OS user).
import "./_env-preload";

import { sql as drizzleSql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  isProviderPhoneSet,
  getValueShapeForRuleType,
  isValidOperatorForRuleType,
} from "@/lib/validators/segment-rule-types";
import { validateMergedRuleShape } from "@/lib/validators/segment-rules";
import { verifyValueOwnership } from "@/lib/api/segment-rule-value-ownership";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures++;
  }
}

function testGuard() {
  console.log("isProviderPhoneSet");
  check("accepts a well-formed set", isProviderPhoneSet({ provider_id: 3, phone_ids: [26, 43] }));
  check("rejects empty phone_ids", !isProviderPhoneSet({ provider_id: 3, phone_ids: [] }));
  check("rejects duplicate phone_ids", !isProviderPhoneSet({ provider_id: 3, phone_ids: [26, 26] }));
  check("rejects a non-array phone_ids", !isProviderPhoneSet({ provider_id: 3, phone_ids: 26 }));
  check("rejects a missing provider_id", !isProviderPhoneSet({ phone_ids: [26] }));
  check("rejects zero/negative ids", !isProviderPhoneSet({ provider_id: 3, phone_ids: [0] }));
  check(
    "rejects a phone id above int4 max",
    !isProviderPhoneSet({ provider_id: 3, phone_ids: [2147483648] }),
  );
  check(
    "rejects a provider_id above int4 max",
    !isProviderPhoneSet({ provider_id: 2147483648, phone_ids: [26] }),
  );
  check(
    "accepts a phone id exactly at int4 max",
    isProviderPhoneSet({ provider_id: 3, phone_ids: [2147483647] }),
  );
  check("rejects null", !isProviderPhoneSet(null));
  check("rejects an array", !isProviderPhoneSet([26, 43]));
  check("rejects extra keys", !isProviderPhoneSet({ provider_id: 3, phone_ids: [26], period: "1w" }));
}

function testRegistry() {
  console.log("RULE_TYPES registration");
  check(
    "value shape is provider_phone_set",
    getValueShapeForRuleType("sent_from_provider_phone") === "provider_phone_set",
  );
  check("allows is", isValidOperatorForRuleType("sent_from_provider_phone", "is"));
  check("allows is_not", isValidOperatorForRuleType("sent_from_provider_phone", "is_not"));
}

function testMergedShape() {
  console.log("validateMergedRuleShape");
  check(
    "accepts a valid rule",
    validateMergedRuleShape("sent_from_provider_phone", "is", { provider_id: 3, phone_ids: [26] }) === null,
  );
  check(
    "rejects an empty set",
    validateMergedRuleShape("sent_from_provider_phone", "is", { provider_id: 3, phone_ids: [] }) !== null,
  );
  check(
    "rejects a bogus operator",
    validateMergedRuleShape("sent_from_provider_phone", "contains", { provider_id: 3, phone_ids: [26] }) !== null,
  );
}

// Uses real prod rows: org b0ce3435… owns phones 26 (TextHub) and 43.
const ORG = "b0ce3435-5ea2-4510-ab11-8cdd0d0c125b";

async function testOwnership() {
  console.log("verifyValueOwnership");
  const phoneRow = await db.execute<{ id: number; provider_id: number }>(
    drizzleSql`SELECT id, provider_id FROM provider_phones WHERE org_id = ${ORG}::uuid ORDER BY id LIMIT 1`,
  );
  const phone = phoneRow[0];
  const good = await verifyValueOwnership(
    ORG,
    "sent_from_provider_phone",
    { provider_id: phone.provider_id, phone_ids: [phone.id] },
    null,
  );
  check("accepts an owned phone under its own provider", good.ok);

  const wrongProvider = await verifyValueOwnership(
    ORG,
    "sent_from_provider_phone",
    { provider_id: phone.provider_id + 99999, phone_ids: [phone.id] },
    null,
  );
  check("rejects a phone under the wrong provider", !wrongProvider.ok);

  const missing = await verifyValueOwnership(
    ORG,
    "sent_from_provider_phone",
    { provider_id: phone.provider_id, phone_ids: [phone.id, 999999999] },
    null,
  );
  check("rejects an unknown phone id", !missing.ok);

  const carrier = await verifyValueOwnership(ORG, "carrier", ["AT&T"], null);
  check("no longer rejects a carrier string set", carrier.ok);

  const phoneType = await verifyValueOwnership(ORG, "phone_type", ["mobile"], null);
  check("no longer rejects a phone_type string set", phoneType.ok);
}

// --- is_not / EXCEPT hazard -------------------------------------------------
//
// Why this matters: under `is_not`, buildSegmentAudienceClause wraps a rule's
// inner query as `universe EXCEPT inner` (lib/segment-rules-eval.ts,
// ruleSet()). ruleInnerQuery's fallback for a malformed provider_phone_set
// value ({provider_id: 0, phone_ids: []}) matches NOBODY — which EXCEPT turns
// into "matches EVERYBODY". The only guard against a malformed persisted
// value reaching that path is isRuleComplete filtering the rule out of
// buildSegmentAudienceClause's `rules` array before operator/EXCEPT logic runs.
//
// isRuleComplete is module-private (deliberately not exported just to be
// tested), and exercising it via buildSegmentAudienceClause would require a
// real segment_rules row against the shared prod DB — out of scope here. So
// this pins the invariant one level down, at the exact primitive
// isRuleComplete's provider_phone_set branch delegates to:
// `return isProviderPhoneSet(rule.value)`. isRuleComplete takes no operator,
// so "incomplete for is" and "incomplete for is_not" collapse to one check —
// there is no per-operator assertion to make.
//
// LIMITATION: a refactor that stops isRuleComplete delegating to
// isProviderPhoneSet, or that starts special-casing operator inside it, would
// not be caught here — only by exercising isRuleComplete (or the DB-backed
// builder) directly.
function testIsNotHazardInvariant() {
  console.log("is_not / EXCEPT hazard — malformed phone-set never reaches eval");
  // Every malformed shape isRuleComplete must reject for provider_phone_set.
  const malformed: unknown[] = [
    { provider_id: 3, phone_ids: [] }, // empty set — the dangerous one
    { provider_id: 3, phone_ids: [1, 1] }, // duplicates
    { provider_id: 0, phone_ids: [1] }, // non-positive provider
    null,
    [1, 2],
    42,
  ];
  check(
    "every malformed provider_phone_set value fails the completeness guard",
    malformed.every((v) => !isProviderPhoneSet(v)),
  );
  check(
    "a well-formed value still passes it",
    isProviderPhoneSet({ provider_id: 3, phone_ids: [1, 2] }),
  );
}

// --- eval semantics -----------------------------------------------------
//
// Pins the rule's semantics directly in SQL rather than through
// buildSegmentAudienceClause, which would need a real segment carrying the
// rule and would mutate production data to set up. The builder itself is
// covered by the typecheck's exhaustiveness guard plus the browser check in
// Task 7.

// Postgres int[] literal from a set of ids read back from the DB (already
// integers, nothing to escape). Same technique as lib/segment-rules-eval.ts's
// own intArrayLiteral, duplicated locally because that one is not exported.
function intArrayLiteral(values: number[]): string {
  if (values.length === 0) return "ARRAY[]::int[]";
  return "ARRAY[" + values.map((n) => String(Math.trunc(n))).join(",") + "]::int[]";
}

async function testEval() {
  console.log("eval");
  // A contact with a known sent row, and the phone that sent it. Deterministic
  // ORDER BY so LIMIT 1 picks the same row every run.
  const seed = await db.execute<{ contact_id: string; provider_phone_id: number }>(
    drizzleSql`
      SELECT contact_id, provider_phone_id FROM stage_sends
      WHERE org_id = ${ORG}::uuid AND status = 'sent' AND provider_phone_id IS NOT NULL
      ORDER BY contact_id, provider_phone_id
      LIMIT 1
    `,
  );
  const { contact_id, provider_phone_id } = seed[0];

  const hit = await db.execute<{ contact_id: string }>(drizzleSql`
    SELECT DISTINCT contact_id FROM stage_sends
    WHERE org_id = ${ORG}::uuid AND status = 'sent'
      AND provider_phone_id = ANY(ARRAY[${provider_phone_id}]::int[])
      AND contact_id = ${contact_id}::uuid
  `);
  check("the contact matches the number that sent to it", hit.length === 1);

  // Negative case: pinning contact_id in the WHERE makes `SELECT DISTINCT
  // contact_id` return 0 or 1 rows BY CONSTRUCTION, regardless of whether the
  // provider_phone_id filter did anything — `miss.length <= 1` would pass
  // even with the filter deleted. To make a wrong answer distinguishable from
  // a right one, pick a phone this org owns that PROVABLY never sent to this
  // contact (the exact complement of the set that did), then assert the
  // contact does not appear at all (miss.length === 0).
  const sentPhones = await db.execute<{ provider_phone_id: number }>(drizzleSql`
    SELECT DISTINCT provider_phone_id FROM stage_sends
    WHERE org_id = ${ORG}::uuid AND status = 'sent' AND contact_id = ${contact_id}::uuid
    ORDER BY provider_phone_id
  `);
  const sentPhoneIds = sentPhones.map((r) => r.provider_phone_id);

  const nonSending = await db.execute<{ id: number }>(drizzleSql`
    SELECT id FROM provider_phones
    WHERE org_id = ${ORG}::uuid
      AND NOT (id = ANY(${drizzleSql.raw(intArrayLiteral(sentPhoneIds))}))
    ORDER BY id
    LIMIT 1
  `);
  if (nonSending.length === 0) {
    console.log(
      "  skip a phone that never sent to this contact does not match" +
        " (every org-owned phone is in the sent set for this contact — no discriminating phone exists)",
    );
  } else {
    const other = nonSending[0].id;
    const miss = await db.execute<{ contact_id: string }>(drizzleSql`
      SELECT DISTINCT contact_id FROM stage_sends
      WHERE org_id = ${ORG}::uuid AND status = 'sent'
        AND provider_phone_id = ANY(ARRAY[${other}]::int[])
        AND contact_id = ${contact_id}::uuid
    `);
    check("a phone that never sent to this contact does not match", miss.length === 0);
  }

  // System-wide backfill invariant (migration 0129 + Task 2's backfill), not
  // org-scoped by construction: the fact under test is that NO row anywhere
  // was left unstamped, which a per-org filter could not disprove.
  const [remaining] = await db.execute<{ n: string }>(
    drizzleSql`SELECT count(*)::text AS n FROM stage_sends WHERE provider_phone_id IS NULL`,
  );
  check("backfill invariant: no unstamped rows remain", remaining.n === "0");
}

// --- index proof ----------------------------------------------------------
//
// Confirms the planner actually chooses stage_sends_org_provider_phone_sent_idx
// for the eval's query shape, using phone 27 — the selective case (86,762
// rows / 39,099 contacts). Phones 26/43 each match ~1/3 to 1/2 of the org's
// entire contact base and are expected to be slow no matter how they're
// indexed; that's a documented data property, not something to fix here.
// This is deliberately NOT wrapped in check(): if the planner doesn't choose
// the index, the requirement is to report that truthfully, not to tune the
// query or force it with enable_seqscan=off until it "passes".
async function testExplainIndexUsage() {
  console.log("EXPLAIN — index proof (phone 27, the selective case)");
  const planRows = await db.execute<{ "QUERY PLAN": string }>(drizzleSql`
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT DISTINCT contact_id FROM stage_sends
    WHERE org_id = ${ORG}::uuid AND status = 'sent'
      AND provider_phone_id = ANY(ARRAY[27]::int[])
  `);
  const planText = planRows.map((r) => r["QUERY PLAN"]).join("\n");
  console.log(planText);

  const usedIndexOnlyScan =
    /Index Only Scan/.test(planText) && planText.includes("stage_sends_org_provider_phone_sent_idx");
  const execTime = planText.match(/Execution Time: ([\d.]+) ms/)?.[1];
  console.log(
    usedIndexOnlyScan
      ? `  -> chosen: Index Only Scan on stage_sends_org_provider_phone_sent_idx${execTime ? `, Execution Time: ${execTime} ms` : ""}`
      : `  -> planner did NOT choose an index-only scan on stage_sends_org_provider_phone_sent_idx; see the plan above for what it actually chose${execTime ? ` (Execution Time: ${execTime} ms)` : ""}`,
  );
}

async function main() {
  testGuard();
  testRegistry();
  testMergedShape();
  await testOwnership();
  testIsNotHazardInvariant();
  await testEval();
  await testExplainIndexUsage();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
