// Unit checks for Text Request DLR parsing (Phase 3) — pure functions only.
// Run: npx tsx scripts/test-textrequest-dlr.ts
import {
  parseTxrStatusCallback,
  TXR_FAILURE_STATUSES,
  TXR_OPTOUT_ERROR_CODES,
} from "@/lib/sends/textrequest-dlr";

let pass = 0, fail = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++; else { fail++; console.log(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`); }
}
function ok(c: boolean, label: string) { if (c) pass++; else { fail++; console.log(`  ✗ ${label}`); } }

eq(parseTxrStatusCallback('{"message_id":"g-1","status":"Delivered"}'),
   { messageId: "g-1", status: "delivered", errorCode: null }, "delivered -> lowercased status, msgid");
eq(parseTxrStatusCallback('{"message_id":"g-2","status":"failed","errorCode":"2100"}'),
   { messageId: "g-2", status: "failed", errorCode: "2100" }, "failed + errorCode 2100");
eq(parseTxrStatusCallback('{"message_id":123,"status":"sending"}'),
   { messageId: "123", status: "sending", errorCode: null }, "numeric message_id -> string");
eq(parseTxrStatusCallback('{"message_id":"g-3","status":"error","errorCode":2003}'),
   { messageId: "g-3", status: "error", errorCode: "2003" }, "numeric errorCode -> string");
eq(parseTxrStatusCallback("not json"),
   { messageId: null, status: null, errorCode: null }, "non-JSON -> all null");
eq(parseTxrStatusCallback(null),
   { messageId: null, status: null, errorCode: null }, "null body -> all null");
eq(parseTxrStatusCallback("{}"),
   { messageId: null, status: null, errorCode: null }, "empty object -> all null");

ok(TXR_FAILURE_STATUSES.has("failed") && TXR_FAILURE_STATUSES.has("undelivered") && TXR_FAILURE_STATUSES.has("error"),
   "failure statuses include error/failed/undelivered");
ok(!TXR_FAILURE_STATUSES.has("delivered") && !TXR_FAILURE_STATUSES.has("sent"),
   "failure statuses exclude delivered/sent");
ok(TXR_OPTOUT_ERROR_CODES.has("2100") && TXR_OPTOUT_ERROR_CODES.has("30050"),
   "opt-out codes include 2100 + 30050");

console.log(`\ntest-textrequest-dlr: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
