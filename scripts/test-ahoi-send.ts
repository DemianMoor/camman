// Ahoi send() classification: the platform ALWAYS returns HTTP 200 — the
// real result is the body `status` field (Phase 0 fact). This test stubs
// global fetch (no network) and asserts every body shape maps to the
// SendSmsResult contract classifyAttempt already knows how to bucket.
// Run: npx tsx scripts/test-ahoi-send.ts
import { ahoiAdapter } from "@/lib/sends/providers/ahoi";
import { classifyAttempt } from "@/lib/sends/classify-attempt";
import type { NormalizedSendParams } from "@/lib/sends/providers/types";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

const baseParams: NormalizedSendParams = {
  apiKey: "test-key",
  text: "hello",
  recipientE164: "+15642155963",
  senderNumber: "+13158359592",
  leadId: null,
};

function stubFetch(body: unknown, status = 200) {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => ({
    status,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

async function main() {
  // {status:"ok",uuid} -> accepted
  stubFetch({ status: "ok", uuid: "s-abc123" });
  const ok = await ahoiAdapter.send(baseParams);
  check("ok body -> ok:true", ok.ok === true);
  check("ok body -> messageId captured", ok.messageId === "s-abc123");
  check("ok body -> status 200 (HTTP always-200 fact)", ok.status === 200);
  check("ok body -> suppressed always false (Ahoi has no per-send suppression)", ok.suppressed === false);
  check(
    "classifyAttempt buckets it 'accepted'",
    classifyAttempt({ ok: ok.ok, status: ok.status, messageId: ok.messageId, timedOut: ok.timedOut }) === "accepted",
  );

  // {status:"error",error} -> theirs_rejected (still HTTP 200)
  stubFetch({ status: "error", error: "invalid destination" });
  const err = await ahoiAdapter.send(baseParams);
  check("error body -> ok:false", err.ok === false);
  check("error body -> error message captured", err.error === "invalid destination");
  check("error body -> status still 200 (not 0)", err.status === 200);
  check(
    "classifyAttempt buckets it 'theirs_rejected'",
    classifyAttempt({ ok: err.ok, status: err.status, messageId: err.messageId, timedOut: err.timedOut }) === "theirs_rejected",
  );

  // Network failure -> status 0, mine_transport
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const net = await ahoiAdapter.send(baseParams);
  check("network failure -> status 0", net.status === 0);
  check("network failure -> not timed out (connection failure, not abort)", net.timedOut === false);
  check(
    "classifyAttempt buckets it 'mine_transport'",
    classifyAttempt({ ok: net.ok, status: net.status, messageId: net.messageId, timedOut: net.timedOut }) === "mine_transport",
  );

  // Missing sender number -> clean refusal, never throws, never calls fetch.
  let fetchCalled = false;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  }) as unknown as typeof fetch;
  const noSender = await ahoiAdapter.send({ ...baseParams, senderNumber: null });
  check("no senderNumber -> ok:false without a network call", noSender.ok === false && !fetchCalled);
  check(
    "no senderNumber -> classifyAttempt buckets it 'mine_transport' (our config issue)",
    classifyAttempt({ ok: noSender.ok, status: noSender.status, messageId: noSender.messageId, timedOut: noSender.timedOut }) ===
      "mine_transport",
  );

  // Redaction never includes the real api_key; uses 10-digit source/destination.
  const redacted = ahoiAdapter.buildRedactedRequest({ ...baseParams, apiKey: "redacted_1234" });
  check("redacted request carries the placeholder, not a real key", redacted.includes("redacted_1234"));
  check("redacted request never carries the raw apiKey", !redacted.includes(baseParams.apiKey));
  check(
    "redacted request uses 10-digit source/destination (toProviderRecipient)",
    redacted.includes("destination=5642155963") && redacted.includes("source=3158359592"),
    redacted,
  );

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
