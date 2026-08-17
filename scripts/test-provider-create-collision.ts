// ACCEPTANCE PROOF for 869egmakh P3: the create endpoint must never silently
// auto-suffix a provider code when the picked connection type already exists.
// That is precisely how `txh2` came to be, and repeating it by UI would recreate
// the drift the whole card exists to stop.
//
// Real authenticated HTTP requests. Every case that WOULD create a row is either
// expected to fail, or is cleaned up immediately afterwards.
import "./_env-preload";

import { createServerClient } from "@supabase/ssr";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";

const BASE = process.argv[2] ?? "http://localhost:3099";
// --no-writes runs ONLY the cases that are refusals, which by definition create
// nothing. Use it when the target shares the production database — a Vercel
// preview does. Every provider row this org has is real, so the one case that
// actually inserts (the custom / no-API escape hatch) is skipped rather than
// writing a probe row to prod and trusting teardown. See 07-conventions.md:
// probes that WRITE run against the demo database, prod writes need approval.
const NO_WRITES = process.argv.includes("--no-writes");
const EMAIL = process.env.TEST_USER_EMAIL ?? "";
const PASSWORD = process.env.TEST_USER_PASSWORD ?? "";

let failures = 0;
function check(name: string, cond: boolean, detail: string) {
  if (cond) console.log(`  PASS  ${name}\n        ${detail}`);
  else { failures++; console.log(`  FAIL  ${name}\n        ${detail}`); }
}

async function signIn(): Promise<string> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY");
  const jar = new Map<string, string>();
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => Array.from(jar.entries()).map(([name, value]) => ({ name, value })),
      setAll: (cookies) => { for (const { name, value } of cookies) jar.set(name, value); },
    },
  });
  const { error } = await supabase.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (error) throw new Error(`Sign-in failed: ${error.message}`);
  return Array.from(jar.entries()).map(([n, v]) => `${n}=${v}`).join("; ");
}

async function post(cookie: string, body: unknown) {
  const res = await fetch(`${BASE}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const createdIds: number[] = [];

// Delete probe rows ONE AT A TIME with a scalar bind.
//
// ⚠️ Do NOT use `WHERE id = ANY(${createdIds})`. postgres-js does not bind a JS
// array to ANY() here — it throws `ERR_INVALID_ARG_TYPE: The "string" argument
// must be of type string... Received type number`, the DELETE never runs, and
// the probe row is LEFT BEHIND in the database. That happened on the first run
// of this script (row 941 `probe719813` survived and had to be removed by hand).
// A cleanup that fails silently after the assertions have already printed
// "ALL PASS" is worse than no cleanup, because nobody looks.
async function cleanup() {
  if (!createdIds.length) return;
  for (const id of createdIds) {
    await db.execute(sql`DELETE FROM sms_providers WHERE id = ${id}`);
  }
  // Verify, don't assume — the whole point of the bug above.
  const left = (await db.execute(sql`
    SELECT id FROM sms_providers WHERE sms_provider_id LIKE 'probe%'
  `)) as unknown as { id: number }[];
  if (left.length > 0) {
    console.error(`⚠️  CLEANUP INCOMPLETE — probe rows still present: ${left.map((r) => r.id).join(", ")}`);
    failures++;
  } else {
    console.log(`\nCleaned up ${createdIds.length} probe provider row(s): ${createdIds.join(", ")}`);
  }
}

async function main() {
  if (!EMAIL || !PASSWORD) { console.error("TEST_USER_EMAIL / TEST_USER_PASSWORD not set"); process.exit(1); }
  const cookie = await signIn();
  console.log(`Signed in as ${EMAIL} against ${BASE}\n`);

  // Snapshot the provider codes that exist now, so we can prove nothing new
  // appeared behind a refusal.
  const before = (await db.execute(sql`
    SELECT sms_provider_id FROM sms_providers ORDER BY sms_provider_id
  `)) as unknown as { sms_provider_id: string }[];
  const beforeCodes = before.map((r) => r.sms_provider_id).join(",");

  console.log("── Picking an existing type must be REFUSED, not auto-suffixed ──");
  for (const t of ["txh", "ahi", "txr", "tls"]) {
    const r = await post(cookie, { name: `probe ${t}`, connection_type: t });
    const ok =
      r.status === 409 &&
      r.body?.details?.reason === "connection_type_exists" &&
      Array.isArray(r.body?.details?.existing_providers) &&
      r.body.details.existing_providers.length > 0;
    check(
      `${t}: refused with a pointer at the existing row`,
      ok,
      `HTTP ${r.status} reason=${r.body?.details?.reason ?? "-"} existing=${(r.body?.details?.existing_providers ?? []).map((p: { sms_provider_id: string }) => p.sms_provider_id).join("|")}`,
    );
  }

  console.log("\n── TextHub's refusal must cite txh2 too (alias-aware) ──");
  {
    const r = await post(cookie, { name: "probe txh alias", connection_type: "txh" });
    const codes = (r.body?.details?.existing_providers ?? []).map((p: { sms_provider_id: string }) => p.sms_provider_id);
    check(
      "txh refusal lists both txh and txh2",
      codes.includes("txh") && codes.includes("txh2"),
      `existing=${codes.join("|")}`,
    );
  }

  console.log("\n── Separate row requires an explicit distinct code ──");
  {
    const r = await post(cookie, { name: "probe no code", connection_type: "txh", create_separate_row: true });
    check(
      "create_separate_row without a code is rejected",
      r.status === 400,
      `HTTP ${r.status} :: ${r.body?.error ?? ""}`,
    );
  }
  {
    const r = await post(cookie, {
      name: "probe reserved", connection_type: "txh",
      create_separate_row: true, sms_provider_id: "ahi",
    });
    check(
      "another type's CANONICAL code is reserved",
      r.status === 400 && r.body?.details?.reason === "reserved_connection_code",
      `HTTP ${r.status} reason=${r.body?.details?.reason ?? "-"}`,
    );
  }
  {
    // The reserved check must span ALIASES too, not just canonical codes —
    // `txh2` is a registry key, so a row claiming it would be resolved to the
    // TextHub adapter by getAdapter purely by accident.
    const r = await post(cookie, {
      name: "probe alias", connection_type: "ahi",
      create_separate_row: true, sms_provider_id: "txh2",
    });
    check(
      "another type's ALIAS code is reserved",
      r.status === 400 && r.body?.details?.reason === "reserved_connection_code",
      `HTTP ${r.status} reason=${r.body?.details?.reason ?? "-"}`,
    );
  }

  console.log("\n── Contradictory mode fields are rejected, not silently resolved ──");
  {
    // (a) A derived code cannot also be dictated.
    const r = await post(cookie, {
      name: "probe dictated", connection_type: "txh", sms_provider_id: "mycode",
    });
    check(
      "connection_type + typed code (no separate-row) is rejected",
      r.status === 400,
      `HTTP ${r.status} :: ${r.body?.error ?? ""}`,
    );
  }
  {
    // (c) A separate row is meaningless without a type to be a variant of.
    const r = await post(cookie, {
      name: "probe orphan", create_separate_row: true, sms_provider_id: "mycode2",
    });
    check(
      "create_separate_row without a connection_type is rejected",
      r.status === 400,
      `HTTP ${r.status} :: ${r.body?.error ?? ""}`,
    );
  }

  console.log("\n── Nothing was created behind any refusal ──");
  {
    const after = (await db.execute(sql`
      SELECT sms_provider_id FROM sms_providers ORDER BY sms_provider_id
    `)) as unknown as { sms_provider_id: string }[];
    const afterCodes = after.map((r) => r.sms_provider_id).join(",");
    check("provider code set unchanged", beforeCodes === afterCodes, `${after.length} rows: ${afterCodes}`);
  }

  console.log("\n── Custom / no-API provider still works (escape hatch) ──");
  if (NO_WRITES) {
    console.log("  SKIP  --no-writes: this case INSERTS a provider row, and this target shares the production DB.");
  } else {
    const code = `probe${Date.now().toString().slice(-6)}`;
    const r = await post(cookie, { name: "Probe Custom", sms_provider_id: code });
    const ok = r.status === 201 && r.body?.sms_provider_id === code;
    check("custom provider created with the typed code", ok, `HTTP ${r.status} code=${r.body?.sms_provider_id ?? "-"}`);
    if (r.body?.id) createdIds.push(r.body.id);
  }

  // ---- RESOLVABILITY: a created provider must actually be able to send ----
  //
  // P3's suite proved every REFUSAL but never proved the happy path produced a
  // USABLE row. That blind spot is exactly how provider 948 (`tls-t`) was created
  // with adapter_code = NULL and could never send: the picker shipped before
  // migration 0134 added the column, so nothing wrote it and nothing checked.
  // Each case below asserts the created row RESOLVES AN ADAPTER -- or, for a
  // custom provider, correctly resolves to the refusal path.
  console.log("");
  console.log("A created provider must resolve an adapter (the 948 class):");
  if (NO_WRITES) {
    console.log("  SKIP  --no-writes: these cases INSERT provider rows.");
  } else {
    const { getAdapter } = await import("@/lib/sends/providers/registry");
    // The send path's exact resolution shape.
    function drainResolves(row: { adapter_code: string | null; sms_provider_id: string }) {
      const key = row.adapter_code ?? row.sms_provider_id;
      try { return getAdapter(key).key; } catch { return null; }
    }
    async function fetchRow(id: number) {
      const r = (await db.execute(sql`
        SELECT id, sms_provider_id, adapter_code, supports_api_send
        FROM sms_providers WHERE id = ${id}
      `)) as unknown as { id: number; sms_provider_id: string; adapter_code: string | null; supports_api_send: boolean }[];
      return r[0];
    }

    // (1) SEPARATE-ROW: distinct identity, canonical type. The 948 case.
    {
      const code = `probe-tls-${Date.now().toString().slice(-6)}`;
      const r = await post(cookie, {
        name: "Probe Separate Row", connection_type: "tls",
        create_separate_row: true, sms_provider_id: code,
      });
      if (r.status !== 201) {
        check("separate-row provider created", false, `HTTP ${r.status} :: ${r.body?.error ?? ""}`);
      } else {
        createdIds.push(r.body.id);
        const row = await fetchRow(r.body.id);
        check(
          "separate-row: identity distinct, adapter_code canonical",
          row.sms_provider_id === code && row.adapter_code === "tls",
          `sms_provider_id=${row.sms_provider_id} adapter_code=${row.adapter_code ?? "NULL"}`,
        );
        check(
          "separate-row: RESOLVES the Tells adapter (would have failed pre-fix)",
          drainResolves(row) === "tls",
          `resolved=${drainResolves(row) ?? "(unknown_provider refusal)"}`,
        );
      }
    }

    // (2) CUSTOM / no-API: must resolve to the refusal path. Correct behaviour.
    {
      const code = `probe-custom-${Date.now().toString().slice(-6)}`;
      const r = await post(cookie, { name: "Probe Custom Resolvability", sms_provider_id: code });
      if (r.status !== 201) {
        check("custom provider created", false, `HTTP ${r.status} :: ${r.body?.error ?? ""}`);
      } else {
        createdIds.push(r.body.id);
        const row = await fetchRow(r.body.id);
        check("custom: adapter_code is NULL (correct -- no adapter exists)", row.adapter_code === null, `adapter_code=${row.adapter_code ?? "NULL"}`);
        check("custom: resolves to the unknown_provider refusal path", drainResolves(row) === null, `resolved=${drainResolves(row) ?? "(refusal)"}`);
        check("custom: not api-send capable", row.supports_api_send === false, `supports_api_send=${row.supports_api_send}`);
      }
    }

    // (3) DERIVED path: only reachable for a type with NO existing row, since
    //     picking an existing type is (correctly) refused. Reported explicitly
    //     rather than skipped silently.
    {
      // `before` is the pre-run snapshot of every provider code in the org.
      const existingCodes = new Set(before.map((r) => r.sms_provider_id));
      const unused = ["txh", "ahi", "txr", "tls"].filter((k) => !existingCodes.has(k));
      if (unused.length === 0) {
        console.log("  NOTE  every connection type already has a provider row, so the derived-code");
        console.log("        branch is unreachable without deleting one. The separate-row case above");
        console.log("        exercises the same adapterCode assignment.");
      } else {
        const r = await post(cookie, { name: "Probe Derived", connection_type: unused[0] });
        if (r.status === 201) {
          createdIds.push(r.body.id);
          const row = await fetchRow(r.body.id);
          check(
            `derived path (${unused[0]}): adapter_code set and resolves`,
            row.adapter_code === unused[0] && drainResolves(row) === unused[0],
            `adapter_code=${row.adapter_code ?? "NULL"} resolved=${drainResolves(row) ?? "none"}`,
          );
        }
      }
    }
  }

  console.log("\n── Unknown connection type is rejected ──");
  {
    const r = await post(cookie, { name: "probe bogus", connection_type: "not-a-type" });
    check("unknown type rejected", r.status === 400, `HTTP ${r.status} :: ${r.body?.error ?? ""}`);
  }

  await cleanup();

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILURE(S)\n`);
  await db.$client.end({ timeout: 5 });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); } catch (ce) { console.error("cleanup also failed:", ce); }
  try { await db.$client.end({ timeout: 5 }); } catch {}
  process.exit(1);
});
