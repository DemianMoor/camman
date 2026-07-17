// Pure unit checks for the SimpleTexting Phase-1 adapter skeleton — no DB, no
// network. Asserts: the registry resolves 'smpl'; the adapter's self-declared
// key is 'smpl'; send() returns a clean not-implemented FAILURE (never throws);
// parseDlr/parseInbound return null (the "not handled" signal); and TextHub/Ahoi
// still resolve (relocation/registration didn't disturb them).
//
// Run: npx tsx scripts/test-simpletexting-adapter.ts
import { getAdapter, UnknownProviderError } from "@/lib/sends/providers/registry";
import type { NormalizedSendParams, RawWebhook } from "@/lib/sends/providers/types";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

async function main() {
  // Registry resolution — the whole point of Phase 1.
  let smpl: ReturnType<typeof getAdapter> | null = null;
  let threw: unknown = null;
  try {
    smpl = getAdapter("smpl");
  } catch (e) {
    threw = e;
  }
  check("getAdapter('smpl') resolves", threw === null && smpl !== null, String(threw));
  if (!smpl) {
    console.log(`\n${failed} FAILED`);
    process.exit(1);
  }

  check("adapter.key === 'smpl'", smpl.key === "smpl", `got ${smpl.key}`);

  // send() is a not-implemented stub: a clean failed result, never a throw.
  const params: NormalizedSendParams = {
    apiKey: "fake-token",
    text: "hello",
    recipientE164: "+14155550123",
    senderNumber: "+13158359592",
  };
  let sendThrew: unknown = null;
  let result: Awaited<ReturnType<typeof smpl.send>> | null = null;
  try {
    result = await smpl.send(params);
  } catch (e) {
    sendThrew = e;
  }
  check("send() does not throw", sendThrew === null, String(sendThrew));
  check("send() returns ok:false (not implemented)", result?.ok === false, JSON.stringify(result));
  check(
    "send() error names the not-implemented stub",
    typeof result?.error === "string" && result.error.includes("not implemented"),
    result?.error ?? "null",
  );
  check("send() status is 0 (transport-side miss)", result?.status === 0, String(result?.status));

  // buildRedactedRequest never throws and never leaks the token.
  let redacted = "";
  let redactThrew: unknown = null;
  try {
    redacted = smpl.buildRedactedRequest(params);
  } catch (e) {
    redactThrew = e;
  }
  check("buildRedactedRequest() does not throw", redactThrew === null, String(redactThrew));
  check(
    "buildRedactedRequest() does not leak the token",
    !redacted.includes("fake-token"),
    redacted,
  );

  // parseDlr / parseInbound return null (Phase 3/4), never throw.
  const rawWebhook: RawWebhook = { query: {}, body: "", headers: {} };
  check("parseDlr() returns null", smpl.parseDlr(rawWebhook) === null);
  check("parseInbound() returns null", smpl.parseInbound(rawWebhook) === null);

  // Neighboring adapters still resolve — registration didn't disturb them.
  for (const key of ["txh", "txh2", "ahi"]) {
    let t: unknown = null;
    try {
      getAdapter(key);
    } catch (e) {
      t = e;
    }
    check(`getAdapter('${key}') still resolves`, t === null, String(t));
  }

  // Unknown key still throws the typed error.
  let bogusThrew: unknown = null;
  try {
    getAdapter("bogus");
  } catch (e) {
    bogusThrew = e;
  }
  check("getAdapter('bogus') throws UnknownProviderError", bogusThrew instanceof UnknownProviderError);

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
