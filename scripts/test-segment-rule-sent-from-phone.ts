// Validator + ownership + eval assertions for the sent_from_provider_phone
// segment rule. Run: npx tsx --conditions=react-server scripts/test-segment-rule-sent-from-phone.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import {
  isProviderPhoneSet,
  getValueShapeForRuleType,
  isValidOperatorForRuleType,
} from "@/lib/validators/segment-rule-types";
import { validateMergedRuleShape } from "@/lib/validators/segment-rules";

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

async function main() {
  testGuard();
  testRegistry();
  testMergedShape();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
