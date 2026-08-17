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
// ⚠️ UPDATED FOR MIGRATION 0134. The key the drain resolves is now
// `adapter_code`, NOT `sms_provider_id` — those are different columns since the
// identity/type split. Asserting the old column would keep passing only while
// the `txh2` registry alias exists, and would then fail the moment that alias is
// removed, which is precisely the deploy this test is supposed to protect.
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

  console.log("DB-key coverage (every api-send provider's REAL adapter_code):");
  const rows = await sql<{ sms_provider_id: string; adapter_code: string | null }[]>`
    SELECT sms_provider_id, adapter_code FROM sms_providers WHERE supports_api_send = true
  `;
  check("at least one api-send provider row exists", rows.length > 0, `found ${rows.length}`);
  for (const row of rows) {
    // An api-send row with a NULL adapter_code cannot send at all: the drain
    // would call getAdapter("") and refuse with `unknown_provider`. Catch that
    // as its own failure rather than letting it fall through as "unresolvable".
    check(
      `${row.sms_provider_id}: adapter_code is set`,
      row.adapter_code !== null,
      "supports_api_send=true but adapter_code IS NULL — this provider cannot send",
    );
    if (row.adapter_code === null) continue;
    let threw: unknown = null;
    try { getAdapter(row.adapter_code); } catch (e) { threw = e; }
    check(
      `getAdapter('${row.adapter_code}') resolves (adapter_code of ${row.sms_provider_id})`,
      threw === null,
      String(threw),
    );
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

  // The txh2 ROW (id 499, the second TextHub account) is covered by the
  // data-driven adapter_code loop above, which is what the drain actually
  // passes. Deliberately NOT asserting `resolveSenderForStage("txh2")` here:
  // that tests the registry ALIAS, which exists only until it is removed in the
  // final step of the 0134 cutover. Pinning the alias would make this guard fail
  // on exactly the deploy it is meant to protect.

  let bogusThrew: unknown = null;
  try { resolveSenderForStage("bogus"); } catch (e) { bogusThrew = e; }
  check("resolveSenderForStage('bogus') throws UnknownProviderError", bogusThrew instanceof UnknownProviderError);

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
