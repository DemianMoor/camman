// Proves stage.sender_number flows: resolveSenderForStage's closure ->
// adapter.send's NormalizedSendParams -> the real Ahoi request body. No
// network (fetch stubbed), no DB (resolveSenderForStage is exercised
// directly with providerKey="ahoi" — the registry resolution itself was
// proven in Section 1's test-ahoi-registry.ts).
// Run: npx tsx scripts/test-drain-sender-number.ts
import { resolveSenderForStage } from "@/lib/sends/drain";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

async function main() {
  let capturedBody: string | null = null;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    _url: string,
    init?: RequestInit,
  ) => {
    capturedBody = String(init?.body ?? "");
    return {
      status: 200,
      text: async () => JSON.stringify({ status: "ok", uuid: "s-1" }),
    };
  }) as unknown as typeof fetch;

  const sendSms = resolveSenderForStage("ahoi");
  await sendSms({
    apiKey: "k",
    text: "hi",
    number: "+15642155963",
    leadId: null,
    senderNumber: "+13158359592",
  });
  check(
    "resolved ahoi sender posts the stage's sender_number as `source` (10-digit)",
    (capturedBody ?? "").includes("source=3158359592"),
    capturedBody ?? "null",
  );

  // senderNumber omitted entirely (Sender's new field is OPTIONAL — an older
  // TextHub-shaped call site must still compile and run). The resolved ahoi
  // closure forwards null and ahoi.send refuses cleanly rather than posting
  // a malformed request.
  const sendSmsNoSender = resolveSenderForStage("ahoi");
  const res = await sendSmsNoSender({ apiKey: "k", text: "hi", number: "+15642155963" });
  check("senderNumber omitted -> ahoi.send refuses without throwing", res.ok === false);

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
