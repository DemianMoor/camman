// TextHub sender param + national-digit transform. Pure (no network for the
// URL-builder assertions). Mirrors scripts/test-ahoi-send.ts's check() harness.
// Run: npx tsx scripts/test-texthub-send.ts
import { buildSendUrl, toTexthubSender } from "@/lib/sends/texthub";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

async function main() {
  // Transform: 10DLC/TFN E.164 -> 10 national digits.
  check("toTexthubSender strips +1", toTexthubSender("+19175551234") === "9175551234");
  check("toTexthubSender strips bare leading 1", toTexthubSender("19175551234") === "9175551234");
  // Transform: short code passes through unchanged.
  check("toTexthubSender keeps 5-digit short code", toTexthubSender("12345") === "12345");
  check("toTexthubSender keeps 6-digit short code", toTexthubSender("123456") === "123456");

  // buildSendUrl includes sender when set.
  const withSender = buildSendUrl({
    apiKey: "k",
    text: "hi",
    number: "+15642155963",
    sender: toTexthubSender("+19175551234"),
  });
  check("URL carries sender=9175551234", withSender.includes("sender=9175551234"), withSender);

  // buildSendUrl omits sender when absent (still a valid URL).
  const noSender = buildSendUrl({ apiKey: "k", text: "hi", number: "+15642155963" });
  check("URL omits sender when unset", !noSender.includes("sender="), noSender);
  // Invariants preserved.
  check("URL never sets long_url", !withSender.includes("long_url="));
  check("URL never sets group", !withSender.includes("group="));

  // Adapter: refuse-on-null (mirrors Ahoi) — ok:false, no network call.
  let fetchCalled = false;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  }) as unknown as typeof fetch;
  const { texthubAdapter } = await import("@/lib/sends/providers/texthub");
  const noSenderSend = await texthubAdapter.send({
    apiKey: "k", text: "hi", recipientE164: "+15642155963", senderNumber: null,
  });
  check("no senderNumber -> ok:false with no network call", noSenderSend.ok === false && !fetchCalled);
  check("no senderNumber -> status 0 (our config issue)", noSenderSend.status === 0);

  // Adapter: with a sender, the redacted request carries sender + placeholder key.
  const redacted = texthubAdapter.buildRedactedRequest({
    apiKey: "redacted_1234", text: "hi", recipientE164: "+15642155963",
    senderNumber: "+19175551234",
  });
  check("redacted carries sender=9175551234", redacted.includes("sender=9175551234"), redacted);
  check("redacted carries the placeholder key", redacted.includes("redacted_1234"));

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
void main();
