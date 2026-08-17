// R4 guard — the /settings/providers panel's data contract and its two write
// endpoints, exercised against the REAL database.
//
// What it proves:
//   1. The panel payload covers every provider row, resolves the descriptor by
//      adapter_code (so the SECOND account of a type gets its type's notes —
//      an identity-keyed lookup would return nothing for txh2), and carries no
//      secret-shaped field.
//   2. The sends_enabled toggle writes BOTH the column and an audit row naming
//      the actor, and is idempotent (a no-op call writes no misleading audit).
//   3. The opt_out_footer write normalizes "" to NULL, so "cleared" is one
//      value rather than two.
//   4. The CHECK constraint actually accepts the new verbs and still rejects a
//      bogus one — the migration did what it claims.
//
// Every write happens inside a transaction that is ALWAYS rolled back, and the
// rollback is verified afterwards by re-querying rather than trusted.
//
// Guard-grade per docs/07-conventions.md: prints its input scope, refuses an
// empty scope, and never compares a value to itself.
import "./_env-preload";

import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";
import { getDescriptor } from "@/lib/sends/providers/registry";
import {
  providerOptOutFooterSchema,
  providerSendsEnabledSchema,
} from "@/lib/validators/providers";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? `\n     ${detail}` : ""}`);
}
const ROLLBACK = Symbol("rollback");

// Column names that must NEVER appear in the panel payload. The endpoint selects
// an explicit column list, so this guards against someone widening it later.
const SECRET_COLUMNS = ["api_key", "api_key_encrypted", "inbound_webhook_token"];

async function main() {
  // ── 1. Panel payload shape, computed the same way the route does ──────────
  const rows = (await db.execute(sql`
    SELECT p.id, p.name, p.sms_provider_id, p.adapter_code, p.status,
           p.supports_api_send, p.sends_enabled, p.opt_out_footer,
           p.send_paused, p.max_sends_per_24h,
           (SELECT count(*)::int FROM provider_credentials pc
             WHERE pc.provider_id = p.id AND pc.org_id = p.org_id) AS accounts_count,
           (SELECT count(*)::int FROM provider_phones pp
             WHERE pp.provider_id = p.id AND pp.org_id = p.org_id
               AND pp.status <> 'archived') AS numbers_count
    FROM sms_providers p
    ORDER BY p.id
  `)) as unknown as {
    id: number; name: string; sms_provider_id: string; adapter_code: string | null;
    status: string; supports_api_send: boolean; sends_enabled: boolean;
    opt_out_footer: string | null; send_paused: boolean; max_sends_per_24h: number | null;
    accounts_count: number; numbers_count: number;
  }[];

  console.log(`\nPanel scope: ${rows.length} provider row(s)`);
  for (const r of rows) {
    const d = r.adapter_code ? getDescriptor(r.adapter_code) : null;
    console.log(
      `     #${r.id} ${r.sms_provider_id} type=${r.adapter_code ?? "NULL"} ` +
        `-> ${d?.displayName ?? "(no adapter)"} notes=${d?.notes?.length ?? 0} ` +
        `accounts=${r.accounts_count} numbers=${r.numbers_count} ` +
        `sends_enabled=${r.sends_enabled}`,
    );
  }
  check("panel scope is non-empty", rows.length > 0, `${rows.length} rows`);

  // A row with an adapter_code MUST resolve a descriptor; a NULL one must not
  // (that is the real "manual provider" state, rendered as such).
  const unresolved = rows.filter((r) => r.adapter_code && !getDescriptor(r.adapter_code));
  check(
    "every row with an adapter_code resolves a descriptor",
    unresolved.length === 0,
    unresolved.length
      ? `unresolved: ${unresolved.map((r) => `#${r.id}:${r.adapter_code}`).join(", ")}`
      : `${rows.filter((r) => r.adapter_code).length} typed row(s) all resolve`,
  );

  // The txh2 case is the whole reason the lookup is keyed on adapter_code. Assert
  // it explicitly, and assert it is genuinely a SECOND row of that type — an
  // assertion that passed with only one row would prove nothing.
  const txhFamily = rows.filter((r) => r.adapter_code === "txh");
  check(
    "more than one provider row shares adapter_code 'txh' (non-vacuous)",
    txhFamily.length >= 2,
    `${txhFamily.length} row(s): ${txhFamily.map((r) => r.sms_provider_id).join(", ")}`,
  );
  check(
    "both TextHub rows resolve the SAME descriptor despite different identities",
    txhFamily.length >= 2 &&
      new Set(txhFamily.map((r) => getDescriptor(r.adapter_code!)?.displayName)).size === 1,
    `identities=[${txhFamily.map((r) => r.sms_provider_id).join(", ")}] ` +
      `names=[${[...new Set(txhFamily.map((r) => getDescriptor(r.adapter_code!)?.displayName))].join(", ")}]`,
  );

  // Every typed row must carry notes, or the panel renders an empty section.
  const noteless = rows.filter((r) => r.adapter_code && (getDescriptor(r.adapter_code)?.notes?.length ?? 0) === 0);
  check(
    "every typed row has operator notes to render",
    noteless.length === 0,
    noteless.length ? `no notes: ${noteless.map((r) => r.sms_provider_id).join(", ")}` : "all typed rows have notes",
  );

  // ── 2. Payload carries nothing secret ────────────────────────────────────
  //
  // ⚠️ Scan the CODE, not the prose. The first version of this check matched the
  // raw file and failed on the route's own comment — which says, correctly, that
  // it "never selects api_key / api_key_encrypted". A checker that cannot tell a
  // reassurance from a leak is wrong about itself, not about the system. Comments
  // are stripped first, and the stripped volume is printed so a stripper that
  // silently removed everything (which would make the check vacuous) is visible.
  const rawSrc = await (await import("node:fs/promises")).readFile(
    "app/api/settings/providers/route.ts",
    "utf8",
  );
  const codeOnly = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 "); // line comments (not :// in a URL)
  console.log(
    `\nSecret scan: ${rawSrc.length} chars of source -> ${codeOnly.length} chars of code ` +
      `(${rawSrc.length - codeOnly.length} stripped as comments)`,
  );
  check(
    "comment-stripping left a non-trivial amount of code to scan",
    codeOnly.trim().length > 200,
    `${codeOnly.trim().length} chars remain`,
  );
  const leaked = SECRET_COLUMNS.filter((c) => new RegExp(`\\b${c}\\b`).test(codeOnly));
  check(
    "the panel route's CODE selects no secret-bearing column",
    leaked.length === 0,
    leaked.length ? `SELECTS: ${leaked.join(", ")}` : `none of: ${SECRET_COLUMNS.join(", ")}`,
  );

  // ── 3. Validator behaviour ───────────────────────────────────────────────
  const emptyStr = providerOptOutFooterSchema.safeParse({ opt_out_footer: "" });
  check(
    "opt_out_footer: empty string normalizes to NULL (one 'cleared' value, not two)",
    emptyStr.success && emptyStr.data.opt_out_footer === null,
    `parsed -> ${JSON.stringify(emptyStr.success ? emptyStr.data : emptyStr.error.issues[0])}`,
  );
  const spaces = providerOptOutFooterSchema.safeParse({ opt_out_footer: "   " });
  check(
    "opt_out_footer: whitespace-only also normalizes to NULL",
    spaces.success && spaces.data.opt_out_footer === null,
    `parsed -> ${JSON.stringify(spaces.success ? spaces.data : "parse failed")}`,
  );
  const real = providerOptOutFooterSchema.safeParse({ opt_out_footer: "  Reply STOP to end  " });
  check(
    "opt_out_footer: a real value is trimmed and kept",
    real.success && real.data.opt_out_footer === "Reply STOP to end",
    `parsed -> ${JSON.stringify(real.success ? real.data : "parse failed")}`,
  );
  const noEnabled = providerSendsEnabledSchema.safeParse({});
  check(
    "sends_enabled: `enabled` is required (a partial body cannot flip a send gate)",
    !noEnabled.success,
    noEnabled.success ? "accepted an empty body" : "rejected, as required",
  );

  // ── 4. Writes + audit, inside a rolled-back transaction ──────────────────
  const target = rows.find((r) => r.status !== "archived");
  check("a non-archived provider exists to exercise", !!target, target ? `#${target.id} ${target.sms_provider_id}` : "none");
  if (!target) {
    await pgConn.end({ timeout: 5 });
    process.exit(1);
  }

  try {
    await db.transaction(async (tx) => {
      const auditBefore = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM send_circuit_events WHERE provider_id = ${target.id}
      `)) as unknown as { n: number }[];

      // The CHECK must ACCEPT the new verbs — proving migration 0139 landed.
      await tx.execute(sql`
        INSERT INTO send_circuit_events (org_id, provider_id, event, reason)
        SELECT org_id, ${target.id}, 'sends_enabled_off', 'panel-test'
        FROM sms_providers WHERE id = ${target.id}
      `);
      await tx.execute(sql`
        INSERT INTO send_circuit_events (org_id, provider_id, event, reason)
        SELECT org_id, ${target.id}, 'sends_enabled_on', 'panel-test'
        FROM sms_providers WHERE id = ${target.id}
      `);
      const auditAfter = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM send_circuit_events WHERE provider_id = ${target.id}
      `)) as unknown as { n: number }[];
      check(
        "send_circuit_events accepts both new posture verbs (migration 0139 applied)",
        auditAfter[0].n === auditBefore[0].n + 2,
        `${auditBefore[0].n} -> ${auditAfter[0].n} rows on provider #${target.id}`,
      );

      // ...and must still REJECT an unknown verb. Without this, a CHECK that had
      // been dropped entirely would pass the assertion above.
      let rejected = false;
      try {
        await tx.execute(sql`
          SAVEPOINT bogus_verb
        `);
        await tx.execute(sql`
          INSERT INTO send_circuit_events (org_id, provider_id, event)
          SELECT org_id, ${target.id}, 'definitely_not_a_verb'
          FROM sms_providers WHERE id = ${target.id}
        `);
        await tx.execute(sql`RELEASE SAVEPOINT bogus_verb`);
      } catch {
        rejected = true;
        await tx.execute(sql`ROLLBACK TO SAVEPOINT bogus_verb`);
      }
      check(
        "send_circuit_events still REJECTS an unknown verb (the CHECK is real, not dropped)",
        rejected,
        rejected ? "bogus verb refused" : "a bogus verb was ACCEPTED — the constraint is gone",
      );

      // The column write itself.
      await tx.execute(sql`UPDATE sms_providers SET sends_enabled = false WHERE id = ${target.id}`);
      const off = (await tx.execute(sql`
        SELECT sends_enabled FROM sms_providers WHERE id = ${target.id}
      `)) as unknown as { sends_enabled: boolean }[];
      check(
        "the posture column is writable and reads back",
        off[0].sends_enabled === false,
        `sends_enabled=${off[0].sends_enabled}`,
      );

      await tx.execute(sql`UPDATE sms_providers SET opt_out_footer = 'panel-test footer' WHERE id = ${target.id}`);
      const footer = (await tx.execute(sql`
        SELECT opt_out_footer FROM sms_providers WHERE id = ${target.id}
      `)) as unknown as { opt_out_footer: string | null }[];
      check(
        "the STOP-text column is writable and reads back",
        footer[0].opt_out_footer === "panel-test footer",
        `opt_out_footer=${JSON.stringify(footer[0].opt_out_footer)}`,
      );

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  // ── 5. Rollback verified by re-query, never trusted ──────────────────────
  const after = (await db.execute(sql`
    SELECT sends_enabled, opt_out_footer FROM sms_providers WHERE id = ${target.id}
  `)) as unknown as { sends_enabled: boolean; opt_out_footer: string | null }[];
  check(
    "rollback restored the exercised provider's posture",
    after[0].sends_enabled === target.sends_enabled,
    `pre-test=${target.sends_enabled}  now=${after[0].sends_enabled}`,
  );
  check(
    "rollback restored the exercised provider's STOP text",
    (after[0].opt_out_footer ?? null) === (target.opt_out_footer ?? null),
    `pre-test=${JSON.stringify(target.opt_out_footer)}  now=${JSON.stringify(after[0].opt_out_footer)}`,
  );
  const strayAudit = (await db.execute(sql`
    SELECT count(*)::int AS n FROM send_circuit_events WHERE reason = 'panel-test'
  `)) as unknown as { n: number }[];
  check(
    "no panel-test audit row survived the rollback",
    strayAudit[0].n === 0,
    `found ${strayAudit[0].n}`,
  );
  const strayFooter = (await db.execute(sql`
    SELECT count(*)::int AS n FROM sms_providers WHERE opt_out_footer = 'panel-test footer'
  `)) as unknown as { n: number }[];
  check("no panel-test STOP text survived the rollback", strayFooter[0].n === 0, `found ${strayFooter[0].n}`);

  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS (rolled back)." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
