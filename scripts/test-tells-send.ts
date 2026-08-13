// Unit checks for the Tells.co send path (Phase 2) — pure functions only, no
// network. Run: npx tsx scripts/test-tells-send.ts
//
// Every fixture below is a VERBATIM payload from the Phase 0 live probe
// (spec §5.1), not an invention. The point of this file is that the traps which
// would fail SILENTLY are pinned: HTTP 200 on auth failure, the string/number
// `id` asymmetry, and never marking a row sent without a message id.
import {
  toTellsRecipient,
  tellsPhoneToE164,
  buildTellsSendBody,
  classifyTellsSend,
  tellsAdapter,
  TELLS_DUPLICATE_STATUS,
} from "@/lib/sends/providers/tells";
import { classifyAttempt } from "@/lib/sends/classify-attempt";
import type { NormalizedSendParams } from "@/lib/sends/providers/types";

let pass = 0, fail = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; } else { fail++; console.log(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`); }
}
function ok(cond: boolean, label: string) { if (cond) pass++; else { fail++; console.log(`  ✗ ${label}`); } }

// --- recipient encoding: bare 11-digit, the form Tells echoes (probe A1) ---
eq(toTellsRecipient("+15717709669"), "15717709669", "E.164 -> bare 11-digit");
eq(toTellsRecipient("5717709669"), "15717709669", "10-digit -> prepend 1");
eq(toTellsRecipient("15717709669"), "15717709669", "11-digit passthrough");
eq(toTellsRecipient("+1 (571) 770-9669"), "15717709669", "formatted -> stripped");

// --- inverse, used by the Phase 3 opt-out path ---
eq(tellsPhoneToE164("15717709669"), "+15717709669", "11-digit -> E.164");
eq(tellsPhoneToE164(15717709669), "+15717709669", "NUMBER -> E.164 (webhooks send numbers)");
eq(tellsPhoneToE164("5717709669"), "+15717709669", "10-digit -> E.164");
eq(tellsPhoneToE164("not-a-phone"), null, "junk -> null (never a bogus contact on a compliance path)");
eq(tellsPhoneToE164(null), null, "null -> null");
eq(tellsPhoneToE164("123"), null, "too short -> null");

// --- request body ---
const base: NormalizedSendParams = {
  apiKey: "k", text: "hello", recipientE164: "+15717709669", senderNumber: "+18445694179",
};
eq(Object.fromEntries(buildTellsSendBody({ apiKey: "k", text: "hello", from: "18445694179", to: "15717709669" })),
   { key: "k", from: "18445694179", to: "15717709669", message: "hello" },
   "body: no metadata -> no metadata param");
eq(Object.fromEntries(buildTellsSendBody({
     apiKey: "k", text: "hello", from: "18445694179", to: "15717709669",
     metadata: { stage_send_id: "abc-123" },
   })),
   { key: "k", from: "18445694179", to: "15717709669", message: "hello",
     metadata: '{"stage_send_id":"abc-123"}' },
   "body: metadata serialized as a JSON STRING (Tells echoes a string regardless)");
eq(Object.fromEntries(buildTellsSendBody({
     apiKey: "k", text: "hi", from: "1", to: "2", metadata: {},
   })).metadata, undefined, "body: empty metadata object -> param omitted");

// --- SUCCESS (verbatim probe A1a response) ---
const okBody = '{"id":"2303145641","to":"15717709669","from":"18445694179","message":"CamMan probe A1a e164","status":"queued","sms_count":1,"sms_charge":0.0128,"date":"2026-08-12T21:59:02+00:00","timezone":"UTC"}';
let c = classifyTellsSend(200, okBody);
ok(c.ok && c.messageId === "2303145641", "200 queued+id -> ok with messageId");
eq(c.segmentsCount, 1, "success -> segmentsCount from sms_count");
eq(c.suppressed, false, "success -> never suppressed (Tells has no such status)");
eq(classifyAttempt(c), "accepted", "success -> classifyAttempt accepted");

// --- multi-segment: one id, sms_count 2 (no DLR fragmentation) ---
c = classifyTellsSend(200, '{"id":"2303145999","status":"queued","sms_count":2,"sms_charge":0.0256}');
ok(c.ok && c.messageId === "2303145999", "multi-segment -> still ONE id");
eq(c.segmentsCount, 2, "multi-segment -> segmentsCount 2");

// --- ⚠️ THE TRAP: all three send errors arrive as HTTP 200 ---
c = classifyTellsSend(200, '{"status":"error","message":"Invalid api key."}');
ok(!c.ok, "HTTP 200 + Invalid api key -> NOT ok (status-only would read success)");
eq(c.messageId, null, "bad key -> no messageId");
eq(c.error, "Invalid api key.", "bad key -> provider message surfaced verbatim");
eq(classifyAttempt(c), "theirs_rejected", "bad key -> theirs_rejected");

c = classifyTellsSend(200, '{"status":"error","message":"From number is required."}');
ok(!c.ok && c.error === "From number is required.", "HTTP 200 + missing from -> NOT ok");

c = classifyTellsSend(200, '{"status":"error","message":"Service Unavailable: The phone number (12025550143) is not enabled for SMS API."}');
ok(!c.ok && (c.error ?? "").includes("not enabled for SMS API"), "HTTP 200 + number not SMS-enabled -> NOT ok");

// --- 429 duplicate: its own marker, non-retryable (Q5 closed: means OUR bug) ---
c = classifyTellsSend(429, '{"status":"error","message":"Duplicate request detected. Please try again later."}');
ok(!c.ok, "429 duplicate -> NOT ok");
eq(c.providerStatus, TELLS_DUPLICATE_STATUS, "429 -> distinct providerStatus marker 'duplicate'");
eq(c.messageId, null, "429 -> no messageId (the send was refused, nothing landed)");
eq(classifyAttempt(c), "theirs_rejected", "429 -> theirs_rejected (no 5th enum value; CHECK-constrained)");

// --- never mark a row sent without an id (drain keys 'sent' off res.ok) ---
c = classifyTellsSend(200, '{"status":"queued"}');
ok(!c.ok, "queued but NO id -> NOT ok (never a sent row with a null message id)");
c = classifyTellsSend(200, "<html>gateway error</html>");
ok(!c.ok && c.rawBody === "<html>gateway error</html>", "unparseable body -> NOT ok, rawBody kept verbatim");
c = classifyTellsSend(200, null);
ok(!c.ok, "empty body -> NOT ok");

// --- defensive: id as a NUMBER (webhook shape leaking into a send response) ---
c = classifyTellsSend(200, '{"id":2303145641,"status":"queued","sms_count":1}');
eq(c.messageId, "2303145641", "numeric id -> coerced to STRING (correlation depends on it)");

async function main() {
  // --- no sender: refuse locally, never spend a round trip ---
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { fetchCalls++; throw new Error("must not be called"); }) as typeof fetch;
  const refused = await tellsAdapter.send({ ...base, senderNumber: null });
  globalThis.fetch = realFetch;
  ok(!refused.ok && fetchCalls === 0, "no sender -> refuses WITHOUT a network call");
  eq(refused.status, 0, "no sender -> status 0");
  eq(classifyAttempt(refused), "mine_transport", "no sender -> mine_transport (ours to fix)");

  // --- timeout is indeterminate and must NOT be retried ---
  eq(classifyAttempt({ ok: false, status: 0, messageId: null, timedOut: true }),
     "indeterminate", "timeout -> indeterminate (may have landed; never re-send)");

  // --- redaction: the api key is a form PARAM here, so this is load-bearing ---
  const redacted = tellsAdapter.buildRedactedRequest({ ...base, apiKey: "redacted_9xyz", metadata: { stage_send_id: "s1" } });
  ok(!redacted.includes("SUPERSECRET"), "redacted request never contains a real key");
  ok(redacted.includes("key=redacted_9xyz"), "redacted request carries the placeholder");
  ok(redacted.includes("metadata=") && redacted.includes("stage_send_id"),
     "redacted request mirrors the metadata actually sent");
  ok(redacted.startsWith("POST "), "redacted request records the POST method");

  console.log(`\n${fail === 0 ? "✓ ALL PASS" : "✗ FAILED"}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
