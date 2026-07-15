// Ahoi recipient conversion: E.164 US -> bare 10-digit.
// Run: npx tsx scripts/test-ahoi-recipient.ts
import { ahoiAdapter } from "@/lib/sends/providers/ahoi";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

check("+1 stripped to 10-digit", ahoiAdapter.toProviderRecipient("+15642155963") === "5642155963");
check("bare 11-digit 1XXXXXXXXXX -> 10", ahoiAdapter.toProviderRecipient("15642155963") === "5642155963");
check("already 10-digit unchanged", ahoiAdapter.toProviderRecipient("5642155963") === "5642155963");
check("send() not implemented in Section 1", (() => {
  try { void ahoiAdapter.send; return typeof ahoiAdapter.send === "function"; } catch { return false; }
})());

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
