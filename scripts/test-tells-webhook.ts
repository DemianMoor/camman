// Unit checks for the Tells.co webhook intake (Phase 3) — pure functions only,
// no network, no DB. Run: npx tsx scripts/test-tells-webhook.ts
//
// Fixtures are VERBATIM Phase 0 probe payloads (spec §5.1). The three things
// pinned hardest are the ones that fail silently and, on the inbound path,
// fail COMPLIANCE:
//   1. §4.6 Key redaction — a live API key must never reach raw_body.
//   2. the lowercase `metadata` trap — the field all DLR correlation depends on.
//   3. the opt-out keyword gate, including decorated STOP variants.
import {
  redactTellsKeyFromBody,
  readTellsKeyField,
  safeEqual,
  tellsDlrDedupKey,
  tellsInboundDedupKey,
  extractTellsFields,
  readStageSendIdFromMetadata,
  looksLikeTellsPayload,
  TELLS_KEY_REDACTION_MARKER,
} from "@/lib/sends/tells-webhook-shared";
import { isOptOutKeyword } from "@/lib/sends/opt-out-keywords";

let pass = 0, fail = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; } else { fail++; console.log(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`); }
}
function ok(cond: boolean, label: string) { if (cond) pass++; else { fail++; console.log(`  ✗ ${label}`); } }

// Verbatim probe payloads.
const DLR_DELIVERED = '{"Id":2303145809,"To":15717709669,"From":18445694179,"Status":"delivered","Date":"2026-08-12T21:59:09Z","Timezone":"UTC","ErrorMessage":"No error.","metadata":null}';
const DLR_UNDELIVERED = '{"Id":2303223141,"To":15717709669,"From":18445694179,"Status":"undelivered","Date":"2026-08-12T22:21:58Z","Timezone":"UTC","ErrorMessage":"Network Error","metadata":null}';
const FAKE_KEY = "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk"; // 50 chars, shape of a real one
const INBOUND_STOP = `{"Key":"${FAKE_KEY}","To":18445694179,"From":15717709669,"Body":"Stop","SMSCount":1,"SMSCharge":"0.0128","Date":"2026-08-12T22:19:46+00:00","Timezone":"UTC"}`;

// ===========================================================================
// §4.6 — Key redaction. THE compliance-critical assertion in this file.
// ===========================================================================
const redacted = redactTellsKeyFromBody(INBOUND_STOP);
ok(redacted !== null, "redaction: returns a body");
ok(!redacted!.includes(FAKE_KEY), "⭐ redaction: the API KEY IS GONE from the persisted body");
ok(redacted!.includes(TELLS_KEY_REDACTION_MARKER), "redaction: marker present");
// Everything else must survive byte-for-byte in value terms.
const rp = JSON.parse(redacted!) as Record<string, unknown>;
eq(rp.Body, "Stop", "redaction: Body untouched");
eq(rp.From, 15717709669, "redaction: From untouched (still a NUMBER)");
eq(rp.To, 18445694179, "redaction: To untouched");
eq(rp.Date, "2026-08-12T22:19:46+00:00", "redaction: Date untouched");
eq(rp.SMSCharge, "0.0128", "redaction: SMSCharge untouched (still a STRING)");
eq(Object.keys(rp).length, 8, "redaction: no field added or dropped");
// Casing drift on their side must not reintroduce the credential.
const lower = redactTellsKeyFromBody(`{"key":"${FAKE_KEY}","Body":"Stop"}`);
ok(!lower!.includes(FAKE_KEY), "redaction: lowercase `key` also redacted (casing drift)");
const upper = redactTellsKeyFromBody(`{"KEY":"${FAKE_KEY}","Body":"Stop"}`);
ok(!upper!.includes(FAKE_KEY), "redaction: uppercase `KEY` also redacted");
// A DLR has no Key — must pass through byte-identical.
eq(redactTellsKeyFromBody(DLR_DELIVERED), DLR_DELIVERED, "redaction: DLR body unchanged (no Key field)");
// FAIL CLOSED: if we cannot parse it, we cannot prove the key isn't in there.
eq(redactTellsKeyFromBody("<html>nope</html>"), null, "⭐ redaction: unparseable body -> null (fail CLOSED, never risk a plaintext key)");
eq(redactTellsKeyFromBody(null), null, "redaction: null passthrough");
eq(redactTellsKeyFromBody(""), "", "redaction: empty passthrough");

// --- reading the Key for the F1 auth check ---
eq(readTellsKeyField(JSON.parse(INBOUND_STOP)), FAKE_KEY, "auth: Key read for validation");
eq(readTellsKeyField(JSON.parse(DLR_DELIVERED)), null, "auth: DLR carries no Key");
ok(safeEqual(FAKE_KEY, FAKE_KEY), "auth: safeEqual matches identical keys");
ok(!safeEqual(FAKE_KEY, FAKE_KEY.slice(0, -1) + "x"), "auth: safeEqual rejects a near-miss");
ok(!safeEqual(null, FAKE_KEY) && !safeEqual(FAKE_KEY, null), "auth: safeEqual rejects null");
ok(!safeEqual("", ""), "auth: safeEqual rejects empty/empty");

// ===========================================================================
// §4.2 — dedup keys
// ===========================================================================
// ⭐ The DLR key must be STABLE across retries. Date advances every retry, so if
// it leaked into the key each of Tells's 4 retries would book a separate event.
const retry1 = '{"Id":2303145809,"Status":"delivered","Date":"2026-08-12T22:08:54Z"}';
const retry2 = '{"Id":2303145809,"Status":"delivered","Date":"2026-08-12T22:09:54Z"}';
const k1 = tellsDlrDedupKey(extractTellsFields(JSON.parse(retry1)).providerMessageId, extractTellsFields(JSON.parse(retry1)).status);
const k2 = tellsDlrDedupKey(extractTellsFields(JSON.parse(retry2)).providerMessageId, extractTellsFields(JSON.parse(retry2)).status);
eq(k1, k2, "⭐ dlr dedup: key STABLE across retries (Date deliberately excluded)");
eq(k1, "dlr:2303145809:delivered", "dlr dedup: shape");
// sent and delivered are DIFFERENT events for the same message — 2 rows expected.
ok(tellsDlrDedupKey("1", "sent") !== tellsDlrDedupKey("1", "delivered"),
   "dlr dedup: sent != delivered (a success legitimately emits 2 events)");
eq(tellsDlrDedupKey(null, "delivered"), null, "dlr dedup: null id -> null key (row still lands)");
eq(tellsDlrDedupKey("1", null), null, "dlr dedup: null status -> null key");

// Inbound: composite, and two DIFFERENT STOPs must not collapse.
const i = JSON.parse(INBOUND_STOP) as Record<string, unknown>;
const ik = tellsInboundDedupKey(String(i.From), String(i.To), String(i.Body), String(i.Date));
ok(ik!.startsWith("in:15717709669:18445694179:"), "inbound dedup: shape");
ok(ik === tellsInboundDedupKey("15717709669", "18445694179", "Stop", "2026-08-12T22:19:46+00:00"),
   "inbound dedup: deterministic");
ok(ik !== tellsInboundDedupKey("15717709669", "18445694179", "Stop", "2026-08-12T23:00:00+00:00"),
   "inbound dedup: a genuinely later STOP is a DIFFERENT event (why Date is included here)");
ok(ik !== tellsInboundDedupKey("15717709669", "18445694179", "thanks", "2026-08-12T22:19:46+00:00"),
   "inbound dedup: different body -> different key");
eq(tellsInboundDedupKey(null, "1", "x", "d"), null, "inbound dedup: missing From -> null");

// ===========================================================================
// §4.4 — guarded extraction, incl. the lowercase metadata trap
// ===========================================================================
const d = extractTellsFields(JSON.parse(DLR_DELIVERED));
eq(d.providerMessageId, "2303145809", "⭐ extract: numeric Id coerced to STRING (correlation depends on it)");
eq(d.fromNumber, "18445694179", "extract: numeric From coerced to string");
eq(d.toNumber, "15717709669", "extract: numeric To coerced to string");
eq(d.status, "delivered", "extract: Status");
eq(d.errorMessage, "No error.", "extract: ErrorMessage present even on success");
eq(d.providerDate, "2026-08-12T21:59:09Z", "extract: Date kept as TEXT, never cast");
eq(d.providerTimezone, "UTC", "extract: Timezone");
eq(d.metadataRaw, null, "extract: metadata null when unset");

const u = extractTellsFields(JSON.parse(DLR_UNDELIVERED));
eq(u.status, "undelivered", "extract: failure path status");
eq(u.errorMessage, "Network Error", "extract: the ErrorMessage that closed self-healing as won't-build");

// ⭐ metadata is LOWERCASE and always a STRING.
const withMeta = extractTellsFields(JSON.parse(
  '{"Id":1,"Status":"sent","metadata":"{\\"stage_send_id\\":\\"3f2504e0-4f89-11d3-9a0c-0305e82c3301\\"}"}'
));
eq(withMeta.metadataRaw, '{"stage_send_id":"3f2504e0-4f89-11d3-9a0c-0305e82c3301"}', "extract: lowercase metadata read");
eq(readStageSendIdFromMetadata(withMeta.metadataRaw), "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
   "⭐ metadata: stage_send_id parsed out of the escaped JSON STRING");
// Reading the PascalCase name would have silently returned nothing on every callback.
ok(extractTellsFields(JSON.parse('{"Id":1,"Status":"sent","metadata":"{}"}')).metadataRaw === "{}",
   "extract: empty metadata object survives as a string");
eq(readStageSendIdFromMetadata("not json"), null, "metadata: malformed -> null, never throws");
eq(readStageSendIdFromMetadata(null), null, "metadata: null -> null");
eq(readStageSendIdFromMetadata('{"other":"x"}'), null, "metadata: missing stage_send_id -> null");
eq(readStageSendIdFromMetadata('"a string"'), null, "metadata: non-object JSON -> null");

// Extraction must NEVER throw — raw_body is the source of truth.
eq(extractTellsFields(null).status, null, "extract: null body -> all nulls");
eq(extractTellsFields("a string").status, null, "extract: non-object -> all nulls");
eq(extractTellsFields([1, 2, 3]).status, null, "extract: array -> all nulls");

// ===========================================================================
// §4.3 — anti-spam shape discriminator
// ===========================================================================
ok(looksLikeTellsPayload(JSON.parse(DLR_DELIVERED), "dlr"), "discriminator: real DLR is Tells-shaped");
ok(looksLikeTellsPayload(JSON.parse(INBOUND_STOP), "inbound"), "discriminator: real inbound is Tells-shaped");
ok(!looksLikeTellsPayload(JSON.parse(DLR_DELIVERED), "inbound"), "discriminator: a DLR is not inbound-shaped");
ok(!looksLikeTellsPayload(null, "dlr"), "discriminator: null -> not shaped (silent 401)");
ok(!looksLikeTellsPayload({ hello: "world" }, "dlr"), "discriminator: scanner junk -> not shaped");
ok(!looksLikeTellsPayload("<html>", "inbound"), "discriminator: html -> not shaped");

// ===========================================================================
// The opt-out keyword gate — decorated variants (the compliance walkthrough)
// ===========================================================================
// Tells sends "Stop" capitalized and undecorated; everything else here is what
// real handsets actually send. All route through the SHARED isOptOutKeyword, so
// the definition of "this is a STOP" cannot drift per provider.
for (const s of ["Stop", "STOP", "stop", "STOP.", "Stop!", "stop please", "Stop ✋️",
                 "STOPALL", "unsubscribe", "Cancel", "END", "quit", "OPTOUT", "opt-out", "REVOKE",
                 "  STOP  ", "STOP\n"]) {
  ok(isOptOutKeyword(s), `keyword: "${s.replace(/\n/g, "\\n")}" IS an opt-out`);
}
for (const s of ["thanks", "yes", "stopping by", "please stop", "I want to stop", "", "  ", "👍"]) {
  ok(!isOptOutKeyword(s), `keyword: "${s}" is NOT an opt-out`);
}

console.log(`\n${fail === 0 ? "✓ ALL PASS" : "✗ FAILED"}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
