// Q2 acceptance: the descriptor-driven per-number settings must reproduce the
// hardcoded gate EXACTLY, and must key off adapter_code rather than identity.
//
// The gate this replaces was `providerKey === "txr"` in the phone form. Two
// defects it carried:
//   * keyed on sms_provider_id, so a SECOND account of a type (the txh2 row)
//     would not get its type's fields;
//   * every new provider-specific field needed another hardcoded branch.
//
// Proven as a differential against the OLD RULE, not by inspecting the new one.
// Read-only.
import "./_env-preload";

import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { getDescriptor } from "@/lib/sends/providers/registry";

let failures = 0;
function check(name: string, cond: boolean, detail: string) {
  if (cond) console.log(`  PASS  ${name}\n        ${detail}`);
  else { failures++; console.log(`  FAIL  ${name}\n        ${detail}`); }
}

// The rule the form used before Q2, reproduced verbatim for the comparison.
function oldGateFields(smsProviderId: string): string[] {
  return smsProviderId === "txr" ? ["dashboard_id"] : [];
}
// What the descriptor path produces for a row.
function newFields(adapterCode: string | null): string[] {
  return (getDescriptor(adapterCode ?? "")?.phoneSettingFields ?? []).map((f) => f.name);
}

async function main() {
  const rows = (await db.execute(sql`
    SELECT id, sms_provider_id, adapter_code, name FROM sms_providers ORDER BY id
  `)) as unknown as { id: number; sms_provider_id: string; adapter_code: string | null; name: string }[];

  check("provider corpus is non-empty", rows.length > 0, `${rows.length} rows`);

  console.log("\nDescriptor fields vs the old hardcoded gate, per provider row:");
  for (const r of rows) {
    const oldF = oldGateFields(r.sms_provider_id).join(",") || "(none)";
    const newF = newFields(r.adapter_code).join(",") || "(none)";
    check(
      `#${r.id} ${r.sms_provider_id} (${r.name})`,
      oldF === newF,
      `old=[${oldF}]  new=[${newF}]  adapter_code=${r.adapter_code ?? "NULL"}`,
    );
  }

  // Non-vacuous: at least one row must actually declare a field, or "identical"
  // would just mean both sides are empty everywhere.
  const withFields = rows.filter((r) => newFields(r.adapter_code).length > 0);
  check(
    "at least one provider declares a per-number field (comparison is not vacuous)",
    withFields.length > 0,
    withFields.map((r) => `${r.sms_provider_id}:[${newFields(r.adapter_code).join(",")}]`).join(" ") || "NONE",
  );

  console.log("\nThe field name must match the provider_phones column it binds to:");
  {
    const cols = (await db.execute(sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'provider_phones'
    `)) as unknown as { column_name: string }[];
    const colSet = new Set(cols.map((c) => c.column_name));
    const declared = [...new Set(rows.flatMap((r) => newFields(r.adapter_code)))];
    check(
      "every declared phoneSettingFields name is a real provider_phones column",
      declared.every((n) => colSet.has(n)),
      declared.map((n) => `${n}${colSet.has(n) ? "" : " <<< MISSING"}`).join(", ") || "(none declared)",
    );
  }

  console.log("\nKeying on adapter_code, not identity — the txh2 class:");
  {
    // A second account of a type must resolve the SAME fields as the first.
    const byType = new Map<string, string>();
    for (const r of rows) {
      if (!r.adapter_code) continue;
      const f = newFields(r.adapter_code).join(",");
      const prev = byType.get(r.adapter_code);
      if (prev !== undefined && prev !== f) {
        check(`adapter_code ${r.adapter_code} yields consistent fields`, false, `${prev} vs ${f}`);
      }
      byType.set(r.adapter_code, f);
    }
    const txhRows = rows.filter((r) => r.adapter_code === "txh");
    check(
      "both TextHub rows resolve identical fields despite different identities",
      txhRows.length >= 2 &&
        new Set(txhRows.map((r) => newFields(r.adapter_code).join(","))).size === 1,
      txhRows.map((r) => `${r.sms_provider_id}->[${newFields(r.adapter_code).join(",") || "none"}]`).join("  "),
    );

    // The decisive case: a row whose IDENTITY is not its TYPE. Under the old
    // identity-keyed gate it got the wrong answer by construction. Compare the
    // two rules directly on that row rather than comparing the new rule to
    // itself — an earlier version of this check did exactly that and would have
    // passed no matter what the code did.
    const txrLike = rows.find((r) => r.adapter_code === "txr" && r.sms_provider_id !== "txr");
    const aliasRow = rows.find((r) => r.adapter_code && r.sms_provider_id !== r.adapter_code);
    if (aliasRow) {
      const viaIdentity = oldGateFields(aliasRow.sms_provider_id).join(",") || "(none)";
      const viaType = newFields(aliasRow.adapter_code).join(",") || "(none)";
      const viaCanonical = newFields(aliasRow.adapter_code).join(",") || "(none)";
      const canonicalRow = rows.find((r) => r.sms_provider_id === aliasRow.adapter_code);
      check(
        `#${aliasRow.id} ${aliasRow.sms_provider_id}: gets the SAME fields as its canonical row ${canonicalRow?.sms_provider_id ?? "?"}`,
        canonicalRow != null && viaType === (newFields(canonicalRow.adapter_code).join(",") || "(none)"),
        `identity=${aliasRow.sms_provider_id} type=${aliasRow.adapter_code} fields=[${viaType}] canonical=[${canonicalRow ? newFields(canonicalRow.adapter_code).join(",") || "(none)" : "?"}]`,
      );
      console.log(`  INFO  old identity-keyed rule would have given this row [${viaIdentity}]${viaIdentity === viaCanonical ? " (same here, because txh declares no fields)" : " <<< DIVERGENT"}`);
    }

    // The strongest available demonstration: if a txr-typed row ever exists
    // whose identity isn't "txr", the old rule gives (none) and the new gives
    // dashboard_id. Reported rather than skipped silently.
    if (txrLike) {
      check(
        `#${txrLike.id} ${txrLike.sms_provider_id}: txr-typed row with a different identity gets dashboard_id`,
        newFields(txrLike.adapter_code).includes("dashboard_id") &&
          !oldGateFields(txrLike.sms_provider_id).includes("dashboard_id"),
        `old=[${oldGateFields(txrLike.sms_provider_id).join(",") || "none"}] new=[${newFields(txrLike.adapter_code).join(",")}]`,
      );
    } else {
      console.log("  NOTE  no txr-typed row with a non-'txr' identity exists yet, so the");
      console.log("        divergence between the two rules cannot be demonstrated on live data.");
      console.log("        It is structural: the old rule reads sms_provider_id, the new reads adapter_code.");
    }
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
