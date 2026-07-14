// The drain resolves the send function via the provider registry, and an
// unknown provider key yields a clean refusal rather than a throw.
// Run: npx tsx scripts/test-drain-adapter-seam.ts
import { getAdapter, UnknownProviderError } from "@/lib/sends/providers/registry";
import { texthubAdapter } from "@/lib/sends/providers/texthub";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

// resolveSenderForStage(providerKey, injected?) mirrors the drain's resolution:
// injected fake wins (test seam), else the registry adapter's send; unknown key
// throws UnknownProviderError which the drain maps to a refusal.
import { resolveSenderForStage } from "@/lib/sends/drain";

const injected = async () => ({ ok: true } as never);
check("injected sender wins", resolveSenderForStage("texthub", injected) === injected);
check("texthub resolves to adapter.send", typeof resolveSenderForStage("texthub") === "function");

let threw: unknown = null;
try { resolveSenderForStage("bogus"); } catch (e) { threw = e; }
check("unknown key throws UnknownProviderError (drain maps to refusal)", threw instanceof UnknownProviderError);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
