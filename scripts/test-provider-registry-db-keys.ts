// Regression test for the registry/DB key mismatch: the provider adapter
// registry (lib/sends/providers/registry.ts) was keyed by descriptive names
// ("texthub"/"ahoi") while the real DB sms_providers.sms_provider_id values
// are short codes ("txh"/"ahi"). The drain resolves getAdapter(stage.provider_key)
// with the DB value, so the mismatch made getAdapter('txh') throw
// UnknownProviderError on every real TextHub stage — verify-drain never caught
// it because it injects a fake sender, bypassing getAdapter entirely (G2).
//
// This test (a) asserts every api-send-capable provider row's REAL DB key
// resolves through the registry, and (b) exercises resolveSenderForStage with
// NO injected sender — the real production resolution path — for both known
// live keys.
//
// Run: npx tsx scripts/test-provider-registry-db-keys.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

import { getAdapter, UnknownProviderError } from "@/lib/sends/providers/registry";
import { resolveSenderForStage } from "@/lib/sends/drain";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const sql = postgres(dbUrl, { prepare: false, max: 1 });

  console.log("DB-key coverage (every api-send provider's REAL sms_provider_id):");
  const rows = await sql<{ sms_provider_id: string }[]>`
    SELECT sms_provider_id FROM sms_providers WHERE supports_api_send = true
  `;
  check("at least one api-send provider row exists", rows.length > 0, `found ${rows.length}`);
  for (const row of rows) {
    const key = row.sms_provider_id;
    // Known duplicate Ahoi provider row (sms_provider_id='ahoi', id 332) —
    // a leftover from before the registry was re-keyed to the real 'ahi'
    // code, slated for removal in a separate reconciliation (Issue 2). It is
    // NOT a key the registry is expected to serve, so it's excluded here
    // rather than asserted against.
    if (key === "ahoi") {
      console.log(`  (skipping known duplicate provider row sms_provider_id='ahoi' — separate reconciliation, Issue 2)`);
      continue;
    }
    let threw: unknown = null;
    try { getAdapter(key); } catch (e) { threw = e; }
    check(`getAdapter('${key}') resolves (real DB key)`, threw === null, String(threw));
  }
  await sql.end();

  console.log("\nReal resolution path (resolveSenderForStage, NO injected sender):");
  let txhThrew: unknown = null;
  let txhFn: unknown = null;
  try { txhFn = resolveSenderForStage("txh"); } catch (e) { txhThrew = e; }
  check("resolveSenderForStage('txh') resolves to a function", typeof txhFn === "function", txhThrew ? String(txhThrew) : "");

  let ahiThrew: unknown = null;
  let ahiFn: unknown = null;
  try { ahiFn = resolveSenderForStage("ahi"); } catch (e) { ahiThrew = e; }
  check("resolveSenderForStage('ahi') resolves to a function", typeof ahiFn === "function", ahiThrew ? String(ahiThrew) : "");

  let bogusThrew: unknown = null;
  try { resolveSenderForStage("bogus"); } catch (e) { bogusThrew = e; }
  check("resolveSenderForStage('bogus') throws UnknownProviderError", bogusThrew instanceof UnknownProviderError);

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
