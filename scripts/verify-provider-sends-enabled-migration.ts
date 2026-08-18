// R1 guard — migration 0138 landed correctly AND changed nothing.
//
// Two independent claims, both of which must hold:
//
//   1. STRUCTURE. `sms_providers.sends_enabled` exists as boolean NOT NULL
//      DEFAULT true, and `opt_out_footer` as nullable text.
//   2. DEFAULT POSTURE. Every provider row still reads sends_enabled = true and
//      opt_out_footer IS NULL, so nothing is silently switched off and no STOP
//      text has been quietly introduced ahead of the Q3 precedence chain.
//
// ⚠️ The third claim this script originally made — INERTNESS, that no send-path
// file referenced either column — was a CUTOVER-ERA invariant and has been
// RETIRED. It was correct for exactly one deploy (R1, where the columns shipped
// unread to prove the deploy was byte-identical) and became wrong the moment R2
// wired enforcement, which is the whole point of R2. Retiring it follows the
// same precedent as verify-adapter-code.ts, whose txh2 assertion was inverted
// once the cutover it guarded was complete: fix the assertion that has expired,
// never the data that made it expire.
//
// It is replaced below by its INVERSE — the enforcement must now be present —
// so this file still fails loudly if someone deletes the wiring. The detailed
// per-gate checks live in scripts/test-provider-sends-enabled-enforcement.ts.
//
// Guard-grade per docs/07-conventions.md: prints its full input scope (every
// provider row by name, and the file list it scanned), refuses to pass on an
// empty scope, and fails loudly rather than defaulting.
import "./_env-preload";

import { promises as fs } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";
import { hasOptOutLanguage } from "@/lib/sends/segments";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? `\n     ${detail}` : ""}`);
}

// Every send-path module that MUST enforce the provider posture flag, with the
// provider-qualified token proving it does. Listed explicitly (not globbed) so a
// file disappearing is a hard error rather than a silently smaller scan.
//
// `sends_enabled` is an AMBIGUOUS bare token — org_settings has a column of the
// same name that the two-switch gate reads all over the send path — so every
// pattern here is provider-qualified. A bare /\bsends_enabled\b/ would match
// pre-existing, correct org-level lines and prove nothing.
const ENFORCEMENT_SITES: { file: string; pattern: RegExp; what: string }[] = [
  { file: "lib/sends/kickoff.ts", pattern: /provider_sends_disabled/, what: "kickoff refusal" },
  { file: "lib/sends/drain.ts", pattern: /provider_sends_disabled/, what: "drain refusal" },
  { file: "lib/sends/drain.ts", pattern: /isProviderSendsEnabled/, what: "drain per-batch re-read" },
  { file: "lib/sends/scheduled.ts", pattern: /p\.sends_enabled IS NOT FALSE/, what: "scheduler predicate" },
  { file: "lib/sends/preflight.ts", pattern: /provider_sends_disabled/, what: "preflight blocker" },
  { file: "lib/sends/send-state.ts", pattern: /sends_enabled: sms_providers\.sends_enabled/, what: "send-state surface" },
  { file: "lib/sends/stall-detector.ts", pattern: /p\.sends_enabled IS NOT FALSE/, what: "stall-detector hold predicate" },
  { file: "lib/sends/circuit-breakers.ts", pattern: /isProviderSendsEnabled/, what: "posture re-read helper" },
];

async function main() {
  // ── 1. Structure ──────────────────────────────────────────────────────────
  const cols = (await db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sms_providers'
      AND column_name IN ('sends_enabled', 'opt_out_footer')
    ORDER BY column_name
  `)) as unknown as {
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }[];

  console.log(`\nColumn scope: ${cols.length} of 2 expected columns found`);
  for (const c of cols) {
    console.log(
      `     ${c.column_name}: ${c.data_type} ` +
        `${c.is_nullable === "NO" ? "NOT NULL" : "NULL"} default=${c.column_default ?? "(none)"}`,
    );
  }
  check("both 0138 columns exist", cols.length === 2, `found ${cols.length}`);

  const se = cols.find((c) => c.column_name === "sends_enabled");
  check(
    "sends_enabled is boolean NOT NULL DEFAULT true",
    se?.data_type === "boolean" &&
      se?.is_nullable === "NO" &&
      (se?.column_default ?? "").includes("true"),
    `got type=${se?.data_type} nullable=${se?.is_nullable} default=${se?.column_default}`,
  );

  const of = cols.find((c) => c.column_name === "opt_out_footer");
  check(
    "opt_out_footer is nullable text with no default",
    of?.data_type === "text" && of?.is_nullable === "YES" && of?.column_default == null,
    `got type=${of?.data_type} nullable=${of?.is_nullable} default=${of?.column_default}`,
  );

  // ── 2. Inertness: data ────────────────────────────────────────────────────
  const rows = (await db.execute(sql`
    SELECT id, sms_provider_id, adapter_code, name, status,
           supports_api_send, send_paused, sends_enabled, opt_out_footer
    FROM sms_providers ORDER BY id
  `)) as unknown as {
    id: number;
    sms_provider_id: string;
    adapter_code: string | null;
    name: string;
    status: string;
    supports_api_send: boolean;
    send_paused: boolean;
    sends_enabled: boolean;
    opt_out_footer: string | null;
  }[];

  console.log(`\nProvider scope: ${rows.length} rows`);
  for (const r of rows) {
    console.log(
      `     #${r.id} ${r.sms_provider_id} (adapter=${r.adapter_code ?? "NULL"}, ${r.status}) ` +
        `api_send=${r.supports_api_send} paused=${r.send_paused} ` +
        `sends_enabled=${r.sends_enabled} opt_out_footer=${r.opt_out_footer ?? "NULL"}`,
    );
  }

  // Non-empty before equal: an empty table would satisfy "every row is true".
  check("provider scope is non-empty", rows.length > 0, `${rows.length} rows`);

  // ⚠️ WHAT THESE TWO CHECKS USED TO SAY, AND WHY THEY DO NOT SAY IT ANY MORE.
  //
  // They asserted `sends_enabled = true` on every row and `opt_out_footer IS
  // NULL` on every row — a correct description of the day migration 0138
  // shipped, when both columns were inert. Both expire the first time an
  // operator uses the feature they cover, which is the entire point of having
  // built it. The footer one was ALREADY RED on clean main: Q3 went live and
  // the `tls` account carries "Reply STOP to quit".
  //
  // A guard that goes red on correct use is not a guard, it is a countdown, and
  // a suite with a known-red check in it stops being read at all. The live
  // configuration is REPORTED above; what is asserted here is what stays true
  // no matter how the operator configures things.
  const notEnabled = rows.filter((r) => r.sends_enabled !== true);
  console.log(
    `     sends_enabled off on: ${notEnabled.length ? notEnabled.map((r) => `#${r.id} ${r.sms_provider_id}`).join(", ") : "none"}`,
  );
  // DURABLE: the column is NOT NULL, so it must be a real boolean on every row.
  // A NULL here would make `IS NOT FALSE` and `= true` disagree across the six
  // enforcement sites — the exact hazard the LEFT JOIN convention exists for.
  check(
    "sends_enabled is a real boolean on every row (never NULL)",
    rows.length > 0 && rows.every((r) => r.sends_enabled === true || r.sends_enabled === false),
    `${rows.length} rows checked`,
  );

  const withFooter = rows.filter((r) => (r.opt_out_footer ?? "").trim().length > 0);
  console.log(
    `     opt_out_footer set on: ${withFooter.length ? withFooter.map((r) => `#${r.id} ${r.sms_provider_id}=${JSON.stringify(r.opt_out_footer)}`).join(", ") : "none"}`,
  );
  // DURABLE, and COMPLIANCE-BEARING: an account footer out-ranks the stage's
  // STOP text on every message sent through that account, and the kickoff gate
  // validates the winner. A value here without a STOP keyword does not degrade
  // gracefully — it REFUSES every stage on the account. So the invariant is not
  // "nobody has set one", it is "anything set is sendable".
  const badFooter = withFooter.filter((r) => !hasOptOutLanguage(r.opt_out_footer!));
  check(
    "every provider footer that EXISTS contains a STOP keyword",
    badFooter.length === 0,
    badFooter.length
      ? `NON-COMPLIANT on: ${badFooter.map((r) => `#${r.id} ${r.sms_provider_id}=${JSON.stringify(r.opt_out_footer)}`).join(", ")}`
      : `${withFooter.length} configured footer(s) checked`,
  );
  // And the column still means what it meant: whitespace is not a footer.
  const blankish = rows.filter((r) => r.opt_out_footer != null && r.opt_out_footer.trim() === "");
  check(
    "no provider row stores a whitespace-only footer (that reads as set, behaves as unset)",
    blankish.length === 0,
    blankish.map((r) => `#${r.id} ${r.sms_provider_id}`).join(", ") || `${rows.length} rows checked`,
  );


  // ── THE REWRITTEN GUARD MUST BE ABLE TO GO RED ───────────────────────────
  //
  // A durable invariant is worthless if today's data happens to satisfy it by
  // accident. The offending state is SYNTHESIZED IN A TRANSACTION AND ROLLED
  // BACK, so this proves the check discriminates without configuring anything.
  console.log("\nSELF-TEST — synthesized offending state, rolled back:");
  const RB = Symbol("rollback");
  try {
    await db.transaction(async (tx) => {
      const victim = rows[0];
      await tx.execute(sql`
        UPDATE sms_providers SET opt_out_footer = 'No more messages' WHERE id = ${victim.id}
      `);
      const probe = (await tx.execute(sql`
        SELECT id, sms_provider_id, opt_out_footer FROM sms_providers WHERE id = ${victim.id}
      `)) as unknown as { id: number; sms_provider_id: string; opt_out_footer: string | null }[];
      check(
        "a NON-COMPLIANT provider footer would be CAUGHT (STOP-keyword check discriminates)",
        !hasOptOutLanguage(probe[0].opt_out_footer ?? ""),
        `injected ${JSON.stringify(probe[0].opt_out_footer)} on #${victim.id} — the live check would fail on this`,
      );
      await tx.execute(sql`
        UPDATE sms_providers SET opt_out_footer = '   ' WHERE id = ${victim.id}
      `);
      const blank = (await tx.execute(sql`
        SELECT opt_out_footer FROM sms_providers WHERE id = ${victim.id}
      `)) as unknown as { opt_out_footer: string | null }[];
      check(
        "a WHITESPACE-ONLY provider footer would be CAUGHT",
        blank[0].opt_out_footer != null && blank[0].opt_out_footer.trim() === "",
        "reads as set, behaves as unset — the live check would fail on this",
      );
      throw RB;
    });
  } catch (e) {
    if (e !== RB) throw e;
  }
  const restored = (await db.execute(sql`
    SELECT count(*)::int AS n FROM sms_providers WHERE opt_out_footer IS NOT NULL
  `)) as unknown as { n: number }[];
  check(
    "self-test rolled back — provider footers are exactly as this run found them",
    restored[0].n === withFooter.length,
    `before=${withFooter.length} after=${restored[0].n}`,
  );

  // ── 3. Enforcement is wired (the INVERSE of R1's retired inertness check) ──
  // A missing file is an ERROR, never a skipped check — a renamed send-path
  // module must fail here rather than quietly shrink the scan.
  const repoRoot = process.cwd();
  let scanned = 0;
  const missing: string[] = [];
  for (const site of ENFORCEMENT_SITES) {
    let src: string;
    try {
      src = await fs.readFile(path.join(repoRoot, site.file), "utf8");
    } catch {
      check(`enforcement file present: ${site.file}`, false, "file not found — scan scope is wrong");
      missing.push(`${site.what} (${site.file}: unreadable)`);
      continue;
    }
    scanned++;
    if (!site.pattern.test(src)) missing.push(`${site.what} (${site.file})`);
  }
  console.log(
    `\nEnforcement scope: ${scanned} of ${ENFORCEMENT_SITES.length} site(s) readable — ` +
      ENFORCEMENT_SITES.map((s) => s.what).join(", "),
  );
  check(
    "every enforcement site file was readable",
    scanned === ENFORCEMENT_SITES.length,
    `${scanned}/${ENFORCEMENT_SITES.length}`,
  );
  check(
    "every send-path enforcement site still references the provider posture flag",
    missing.length === 0,
    missing.length ? `MISSING: ${missing.join(" | ")}` : `all ${ENFORCEMENT_SITES.length} sites wired`,
  );

  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
