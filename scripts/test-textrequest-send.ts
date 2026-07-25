// Unit checks for the Text Request send path (Phase 2) — pure functions only,
// no network. Run: npx tsx scripts/test-textrequest-send.ts
import {
  toTextrequestRecipient,
  buildMessagesBody,
  classifyTxrSend,
} from "@/lib/sends/providers/textrequest";
import { countSegments, withProviderFooter, TXR_APPENDED_FOOTER } from "@/lib/sends/segments";
import type { NormalizedSendParams } from "@/lib/sends/providers/types";

let pass = 0, fail = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; } else { fail++; console.log(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`); }
}
function ok(cond: boolean, label: string) { if (cond) pass++; else { fail++; console.log(`  ✗ ${label}`); } }

// --- recipient encoding -> TR canonical 11-digit ---
eq(toTextrequestRecipient("+18449903688"), "18449903688", "E.164 -> 11-digit");
eq(toTextrequestRecipient("8449903688"), "18449903688", "10-digit -> prepend 1");
eq(toTextrequestRecipient("18449903688"), "18449903688", "11-digit passthrough");
eq(toTextrequestRecipient("+1 (844) 990-3688"), "18449903688", "formatted -> stripped");

// --- request body ---
const base: NormalizedSendParams = { apiKey: "k", text: "hello", recipientE164: "+18262062523", senderNumber: "+18449903688" };
eq(buildMessagesBody(base), { from: "18449903688", to: "18262062523", body: "hello" }, "body: no callback -> no status_callback");
eq(buildMessagesBody({ ...base, statusCallbackUrl: "https://x/cb?ss=1" }),
   { from: "18449903688", to: "18262062523", body: "hello", status_callback: "https://x/cb?ss=1" },
   "body: callback included when provided");

// --- classification (TR uses real HTTP + body status) ---
let c = classifyTxrSend(200, { status: "sending", message_id: "abc", segments_count: 1 });
ok(c.ok && c.messageId === "abc" && c.segmentsCount === 1 && !c.suppressed, "200 sending -> ok, msgid, segs");

c = classifyTxrSend(200, { status: "error", errorCode: "2002", message: "filtered as spam" });
ok(!c.ok && c.error === "filtered as spam" && !c.suppressed, "200 error 2002 -> fail, not suppressed (spam filter)");

c = classifyTxrSend(200, { status: "error", errorCode: "2100", message: "previously opted out" });
ok(!c.ok && c.suppressed, "200 error 2100 -> fail + suppressed (opt-out)");

c = classifyTxrSend(200, { status: "error", errorCode: "30050" });
ok(!c.ok && c.suppressed, "error 30050 -> suppressed (conversation opt-out code)");

c = classifyTxrSend(400, { status: "error", errorCode: "400", message: "bad request" });
ok(!c.ok && c.error === "bad request", "HTTP 400 -> fail with body message");

c = classifyTxrSend(200, { status: "sending" });
ok(!c.ok, "200 sending but NO message_id -> not ok");

c = classifyTxrSend(500, null);
ok(!c.ok && c.error === "Text Request HTTP 500", "HTTP 500 non-JSON -> fail with HTTP error");

// --- footer-aware segment counting ---
eq(withProviderFooter("hi", "txr"), "hi" + TXR_APPENDED_FOOTER, "withProviderFooter: txr appends footer");
eq(withProviderFooter("hi", "txh"), "hi", "withProviderFooter: non-txr unchanged");
eq(withProviderFooter("hi", null), "hi", "withProviderFooter: null unchanged");

// A body that is 1 segment raw but tips to 2 with the ~21-char footer.
const near = "A".repeat(150); // 150 GSM-7 chars = 1 segment (limit 160)
ok(countSegments(near).segments === 1, "150 chars raw = 1 segment");
ok(countSegments(withProviderFooter(near, "txr")).segments === 2, "150 chars + TR footer = 2 segments (footer changes segment math)");

console.log(`\ntest-textrequest-send: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
