// Migration 0134 gate: prove that resolving an adapter via `adapter_code` gives
// the IDENTICAL adapter to resolving via `sms_provider_id`, for every provider
// row — before any code is switched to read the new column.
//
// This is the whole safety argument for the cutover. `txh2` is the row that
// matters: its sms_provider_id resolves through a registry ALIAS entry, while
// its adapter_code is 'txh' and resolves directly. If those two ever disagreed,
// switching the drain would silently send that account's traffic through the
// wrong provider's client.
//
// Read-only. No writes, safe against production.
import "./_env-preload";

import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { getAdapter, UnknownProviderError } from "@/lib/sends/providers/registry";

let failures = 0;
function check(name: string, cond: boolean, detail: string) {
  if (cond) console.log(`  PASS  ${name}\n        ${detail}`);
  else { failures++; console.log(`  FAIL  ${name}\n        ${detail}`); }
}

// Resolve an adapter, or report why not. Identity is compared by object
// reference — two keys "resolve the same" only if they reach the same adapter.
function resolve(key: string | null): { ok: true; adapter: unknown; name: string } | { ok: false; name: string } {
  if (!key) return { ok: false, name: "(null — no adapter)" };
  try {
    const a = getAdapter(key);
    return { ok: true, adapter: a, name: a.key };
  } catch (e) {
    return { ok: false, name: e instanceof UnknownProviderError ? "(unknown key)" : "(error)" };
  }
}

async function main() {
  const rows = (await db.execute(sql`
    SELECT id, sms_provider_id, adapter_code, name, supports_api_send
    FROM sms_providers ORDER BY id
  `)) as unknown as {
    id: number; sms_provider_id: string; adapter_code: string | null;
    name: string; supports_api_send: boolean;
  }[];

  console.log(`\n── Adapter resolution parity across all ${rows.length} provider rows ──`);
  for (const r of rows) {
    const viaId = resolve(r.sms_provider_id);
    const viaCode = resolve(r.adapter_code);
    const bothResolve = viaId.ok && viaCode.ok;
    const neitherResolves = !viaId.ok && !viaCode.ok;
    const same = bothResolve
      ? (viaId as { adapter: unknown }).adapter === (viaCode as { adapter: unknown }).adapter
      : neitherResolves;
    check(
      `#${r.id} ${r.sms_provider_id} (${r.name})`,
      same,
      `sms_provider_id→${viaId.name}  adapter_code=${r.adapter_code ?? "NULL"}→${viaCode.name}`,
    );
  }

  console.log("\n── The txh2 case specifically (the reason this gate exists) ──");
  {
    const txh2 = rows.find((r) => r.sms_provider_id === "txh2");
    if (!txh2) {
      check("txh2 row present", false, "not found — expected the second TextHub account row");
    } else {
      check("txh2.adapter_code === 'txh'", txh2.adapter_code === "txh", `adapter_code=${txh2.adapter_code ?? "NULL"}`);
      const viaCode = resolve(txh2.adapter_code);
      const viaAlias = resolve("txh2");
      const direct = resolve("txh");
      check(
        "txh2 resolves to the SAME adapter object via alias, adapter_code, and txh",
        viaCode.ok && viaAlias.ok && direct.ok &&
          (viaCode as { adapter: unknown }).adapter === (viaAlias as { adapter: unknown }).adapter &&
          (viaCode as { adapter: unknown }).adapter === (direct as { adapter: unknown }).adapter,
        `alias→${viaAlias.name}  adapter_code→${viaCode.name}  txh→${direct.name}`,
      );
    }
  }

  console.log("\n── Every API-sending row must have a resolvable adapter_code ──");
  for (const r of rows.filter((x) => x.supports_api_send)) {
    const viaCode = resolve(r.adapter_code);
    check(
      `#${r.id} ${r.sms_provider_id} supports_api_send ⇒ adapter_code resolves`,
      viaCode.ok,
      `adapter_code=${r.adapter_code ?? "NULL"}→${viaCode.name}`,
    );
  }

  console.log("\n── Rows with no adapter must be NULL, not a bogus code ──");
  for (const r of rows.filter((x) => !x.supports_api_send)) {
    const viaId = resolve(r.sms_provider_id);
    // A non-API row may legitimately be NULL (snx/smpl). If its sms_provider_id
    // happens to be a registry key, adapter_code must match it rather than be NULL.
    const expectNull = !viaId.ok;
    check(
      `#${r.id} ${r.sms_provider_id} (no API send)`,
      expectNull ? r.adapter_code === null : resolve(r.adapter_code).ok,
      `adapter_code=${r.adapter_code ?? "NULL"} (expected ${expectNull ? "NULL" : "a resolvable code"})`,
    );
  }

  console.log("\n── Backfill completeness: no row left undecided ──");
  {
    const undecided = rows.filter((r) => r.adapter_code === null && resolve(r.sms_provider_id).ok);
    check(
      "no row has a resolvable sms_provider_id but a NULL adapter_code",
      undecided.length === 0,
      undecided.length ? undecided.map((r) => `${r.id}:${r.sms_provider_id}`).join(", ") : "none",
    );
  }

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILURE(S)\n`);
  await db.$client.end({ timeout: 5 });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  try { await db.$client.end({ timeout: 5 }); } catch {}
  process.exit(1);
});
