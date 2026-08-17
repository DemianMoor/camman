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

  // ── POST-CUTOVER invariant, replacing the original parity assertion ────────
  //
  // This script began as the one-shot CUTOVER gate: prove adapter_code resolved
  // to the IDENTICAL adapter as sms_provider_id for every row, before switching
  // any reader. That was exactly right while proving the switch was a no-op —
  // and exactly WRONG to keep asserting afterwards, because the entire purpose
  // of the split is that the two columns may legitimately differ.
  //
  // It failed the moment a real provider exercised that: `tls-t` (a second Tells
  // account) has identity `tls-t`, which resolves to nothing, and type `tls`,
  // which resolves to the Tells adapter. Correct and desirable — and a failure
  // under the old rule. The equivalence was a property of the migration moment,
  // not of the schema.
  console.log(`\nEffective key resolves for every one of the ${rows.length} provider rows:`);
  for (const r of rows) {
    // Exactly what the send path does: COALESCE(adapter_code, sms_provider_id).
    const effective = r.adapter_code ?? r.sms_provider_id;
    const res = resolve(effective);
    // A non-NULL adapter_code MUST resolve. A typed-but-unregistered value is
    // the one genuinely broken state — worse than NULL, which refuses cleanly.
    check(
      `#${r.id} ${r.sms_provider_id} (${r.name})`,
      r.adapter_code === null || res.ok,
      `effective=${effective} -> ${res.name}${r.adapter_code === null ? "  [NULL: refuses cleanly, correct for a custom provider]" : ""}`,
    );
  }

  console.log("\nThe txh2 case specifically (the row this whole split exists for):");
  {
    const txh2 = rows.find((r) => r.sms_provider_id === "txh2");
    if (!txh2) {
      check("txh2 row present", false, "not found — expected the second TextHub account row");
    } else {
      check("txh2.adapter_code === 'txh'", txh2.adapter_code === "txh", `adapter_code=${txh2.adapter_code ?? "NULL"}`);
      const viaCode = resolve(txh2.adapter_code);
      const direct = resolve("txh");
      // The ROW resolves to the same adapter object as txh, via adapter_code.
      check(
        "txh2 row resolves to the SAME adapter object as txh, via adapter_code",
        viaCode.ok && direct.ok &&
          (viaCode as { adapter: unknown }).adapter === (direct as { adapter: unknown }).adapter,
        `adapter_code=${txh2.adapter_code}->${viaCode.name}  txh->${direct.name}`,
      );
      // And the IDENTITY string must NOT resolve. This is the assertion that
      // used to demand the opposite: it pinned the registry alias, which existed
      // only to bridge the 0134 cutover. Inverted deliberately — if `txh2` starts
      // resolving again, an alias has crept back and identity is doubling as a
      // lookup key once more, which is the whole defect this split removed.
      check(
        "the bare identity string 'txh2' does NOT resolve (alias stays retired)",
        !resolve("txh2").ok,
        `getAdapter('txh2') -> ${resolve("txh2").name}`,
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

  console.log("\nNot-live rows: adapter_code is NULL or resolvable, never bogus:");
  // "Not api-send capable" does NOT imply "has no adapter". A provider can have
  // a known connection type and simply not be live yet — txr and tls were both
  // in exactly that state, and `tls-t` is today. The only forbidden combination
  // is a non-NULL adapter_code that does not resolve.
  for (const r of rows.filter((x) => !x.supports_api_send)) {
    const res = resolve(r.adapter_code);
    check(
      `#${r.id} ${r.sms_provider_id} (not live for API send)`,
      r.adapter_code === null || res.ok,
      `adapter_code=${r.adapter_code ?? "NULL"}${r.adapter_code ? ` -> ${res.name}` : " (custom / no adapter)"}`,
    );
  }

  // Migrated from the retired 0134 cutover differential: every provider that
  // actually has stages attached must resolve, so a mis-set adapter_code shows
  // up here rather than as a drain-time refusal on a live campaign.
  console.log("\nEvery provider with send-eligible stages resolves an adapter:");
  {
    const groups = (await db.execute(sql`
      SELECT p.sms_provider_id AS ident, p.adapter_code, count(*)::int AS stages
      FROM campaign_stages s
      JOIN sms_providers p ON p.id = s.sms_provider_id
      WHERE p.supports_api_send = true
      GROUP BY 1, 2 ORDER BY 1
    `)) as unknown as { ident: string; adapter_code: string | null; stages: number }[];
    check("at least one provider has send-eligible stages (non-vacuous)", groups.length > 0, `${groups.length} group(s)`);
    for (const g of groups) {
      const res = resolve(g.adapter_code);
      check(
        `${g.ident}: ${g.stages} stage(s) resolve via adapter_code`,
        res.ok,
        `adapter_code=${g.adapter_code ?? "NULL"} -> ${res.name}`,
      );
    }
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
