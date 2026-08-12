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
// buildSegmentAudienceClause wraps an is_not rule's inner query as
// `universe EXCEPT inner` (lib/segment-rules-eval.ts, ruleSet()). If a
// malformed provider_phone_set value ever reached ruleInnerQuery, its guarded
// fallback (`{provider_id: 0, phone_ids: []}`) produces an inner query that
// matches NOBODY — which under is_not becomes "matches EVERYBODY" once
// wrapped in EXCEPT. The only thing standing between a malformed value and
// that outcome is isRuleComplete filtering the rule out of
// `buildSegmentAudienceClause`'s `rules` array before operator/EXCEPT logic
// ever runs.
//
// isRuleComplete itself is not exported (by design — see lib/segment-rules-eval.ts),
// and exercising it via buildSegmentAudienceClause/previewSegmentAudienceCount
// would require writing a real segment_rules row against the shared prod DB,
// which is out of scope here (same reasoning the Task 5 plan used to avoid
// buildSegmentAudienceClause for the eval-semantics assertions). Instead this
// pins the invariant one level down, at the exact primitive isRuleComplete's
// provider_phone_set branch delegates to: `return isProviderPhoneSet(rule.value)`
// — no other condition, and no operator in isRuleComplete's signature at all.
// So "incomplete for is" and "incomplete for is_not" collapse to the same
// check: isRuleComplete can't distinguish operators, which is exactly why
// filtering happens before ruleSet()/combinedOp() ever look at rule.operator.
// A future refactor that special-cases operator inside isRuleComplete, or that
// stops delegating to isProviderPhoneSet, would not be caught by this test —
// only by exercising isRuleComplete (or the DB-backed builder) directly.
// Pins the invariant "a malformed phone-set rule never reaches the eval".
//
// Why this matters: ruleInnerQuery's fallback for a value that fails the guard
// is {provider_id: 0, phone_ids: []}, whose inner query matches NOBODY. Under
// `is_not`, buildSegmentAudienceClause wraps the inner query as
// `universe EXCEPT inner` — so "matches nobody" would become "matches
// EVERYBODY" and silently blow up a segment's audience. The only thing
// standing between a malformed persisted value and that outcome is
// isRuleComplete filtering it out first.
//
// LIMITATION, stated plainly rather than papered over: isRuleComplete is
// module-private in lib/segment-rules-eval.ts and is deliberately NOT exported
// just to be tested. The operator is irrelevant to the filter — isRuleComplete
// never sees it — so there is no meaningful per-operator assertion to make
// here. What we CAN pin is the delegate isRuleComplete calls for this shape,
// one level down. If a future refactor makes isRuleComplete stop delegating to
// isProviderPhoneSet, this test will still pass while the invariant breaks —
// so that refactor must re-pin the invariant at the eval level (e.g. by
// asserting the built SQL for a malformed + is_not rule matches no one).
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

async function main() {
  testGuard();
  testRegistry();
  testMergedShape();
  await testOwnership();
  testIsNotHazardInvariant();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
