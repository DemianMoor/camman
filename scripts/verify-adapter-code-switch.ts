// Differential proof for the adapter_code CUTOVER (869ej8qzk Part A, step 2).
//
// Each switched read site is run BOTH ways against production data — the old
// sms_provider_id form and the new adapter_code form — and the results must be
// identical. "The new query looks right" is not the bar; the bar is that it
// returns the same rows as the query it replaces.
//
// Read-only. No writes, safe against production.
import "./_env-preload";

import { sql } from "drizzle-orm";
import { db } from "@/db/client";

let failures = 0;
function check(name: string, cond: boolean, detail: string) {
  if (cond) console.log(`  PASS  ${name}\n        ${detail}`);
  else { failures++; console.log(`  FAIL  ${name}\n        ${detail}`); }
}

async function main() {
  console.log("\n── drain / kickoff: provider_key per provider row ──");
  {
    const rows = (await db.execute(sql`
      SELECT id, sms_provider_id, adapter_code, supports_api_send
      FROM sms_providers ORDER BY id
    `)) as unknown as {
      id: number; sms_provider_id: string; adapter_code: string | null; supports_api_send: boolean;
    }[];
    // The switch is only observable for rows whose two columns differ. Prove we
    // KNOW which those are, rather than assuming they're all the same.
    const differing = rows.filter((r) => r.sms_provider_id !== r.adapter_code);
    console.log(`        rows where the value CHANGES: ${differing.length ? differing.map((r) => `${r.sms_provider_id}→${r.adapter_code ?? "NULL"}`).join(", ") : "none"}`);
    // Every differing row must still land on a registered adapter, else the
    // switch would turn a working send into `unknown_provider`.
    const { getAdapter } = await import("@/lib/sends/providers/registry");

    // Compare the DRAIN OUTCOME, not the intermediate representation.
    //
    // The drain does `getAdapter(stage.provider_key ?? "")` inside a try/catch
    // that maps UnknownProviderError to the `unknown_provider` refusal
    // (lib/sends/drain.ts). So an unregistered code and a NULL adapter_code are
    // the SAME outcome: NULL becomes `getAdapter("")`, which throws exactly like
    // `getAdapter("snx")` does today. An earlier version of this check compared
    // the strings "(throws)" vs "(null)" and reported a difference where the
    // behaviour is identical — a distinction the send path cannot observe.
    const NO_ADAPTER = Symbol("no-adapter");
    function drainOutcome(key: string | null): unknown {
      try { return getAdapter(key ?? ""); } catch { return NO_ADAPTER; }
    }
    for (const r of differing) {
      const before = drainOutcome(r.sms_provider_id);
      const after = drainOutcome(r.adapter_code);
      const label = (o: unknown) => (o === NO_ADAPTER ? "unknown_provider refusal" : (o as { key: string }).key);
      check(
        `#${r.id} ${r.sms_provider_id}: drain outcome unchanged by the switch`,
        before === after,
        `before=${label(before)}  after=${label(after)}`,
      );
    }
    // The rows that collapse to a refusal must be non-API rows — otherwise a
    // real sender would now refuse, which is a behaviour change, not a no-op.
    for (const r of differing) {
      if (drainOutcome(r.adapter_code) !== NO_ADAPTER) continue;
      check(
        `#${r.id} ${r.sms_provider_id}: refuses, and is not API-send capable`,
        r.supports_api_send === false,
        `supports_api_send=${r.supports_api_send}`,
      );
    }
    // Non-differing rows are trivially safe, but assert it rather than assume.
    const same = rows.filter((r) => r.sms_provider_id === r.adapter_code);
    check(
      "rows where both columns already agree are unaffected",
      same.every((r) => r.adapter_code !== null),
      `${same.length} rows: ${same.map((r) => r.sms_provider_id).join(", ")}`,
    );
  }

  console.log("\n── poll-opt-outs: selected credential set must be IDENTICAL ──");
  {
    const oldWay = (await db.execute(sql`
      SELECT pc.id AS credential_id
      FROM provider_credentials pc
      JOIN sms_providers p ON p.id = pc.provider_id AND p.org_id = pc.org_id
      WHERE p.supports_api_send = true AND p.sms_provider_id IN ('txh', 'txh2')
      ORDER BY pc.id
    `)) as unknown as { credential_id: number }[];
    const newWay = (await db.execute(sql`
      SELECT pc.id AS credential_id
      FROM provider_credentials pc
      JOIN sms_providers p ON p.id = pc.provider_id AND p.org_id = pc.org_id
      WHERE p.supports_api_send = true AND p.adapter_code = 'txh'
      ORDER BY pc.id
    `)) as unknown as { credential_id: number }[];
    const a = oldWay.map((r) => r.credential_id).join(",");
    const b = newWay.map((r) => r.credential_id).join(",");
    check("credential id set identical", a === b, `old=[${a}]  new=[${b}]`);
    // An empty set would make the comparison vacuous — the poller would simply
    // stop polling and this test would still "pass". Refuse that.
    check("selected set is non-empty (comparison is not vacuous)", oldWay.length > 0, `${oldWay.length} credential(s)`);
  }

  console.log("\n── Send-eligible stages must resolve a provider_key either way ──");
  {
    const rows = (await db.execute(sql`
      SELECT p.sms_provider_id AS old_key, p.adapter_code AS new_key, count(*)::int AS stages
      FROM campaign_stages s
      JOIN sms_providers p ON p.id = s.sms_provider_id
      WHERE p.supports_api_send = true
      GROUP BY p.sms_provider_id, p.adapter_code
      ORDER BY p.sms_provider_id
    `)) as unknown as { old_key: string; new_key: string | null; stages: number }[];
    for (const r of rows) {
      check(
        `${r.old_key}: ${r.stages} stage(s) — new key non-null`,
        r.new_key !== null,
        `old=${r.old_key} new=${r.new_key ?? "NULL"} stages=${r.stages}`,
      );
    }
    check("at least one send-eligible stage exists (non-vacuous)", rows.length > 0, `${rows.length} provider group(s)`);
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
