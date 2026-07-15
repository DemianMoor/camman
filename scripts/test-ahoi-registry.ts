// Registry resolves known providers and rejects unknown ones cleanly.
// Run: npx tsx scripts/test-ahoi-registry.ts
import { getAdapter, UnknownProviderError } from "@/lib/sends/providers/registry";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

const th = getAdapter("txh");
check("texthub adapter resolves", th.key === "txh");
const ah = getAdapter("ahi");
check("ahoi adapter resolves", ah.key === "ahi");

let threw: unknown = null;
try { getAdapter("nope"); } catch (e) { threw = e; }
check("unknown key throws UnknownProviderError", threw instanceof UnknownProviderError);
check("texthub.toProviderRecipient is identity", th.toProviderRecipient("+15551234567") === "+15551234567");

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
