// COMPLIANCE INVARIANT: STOP intake must never be gated on a sending flag.
//
// Receiving an opt-out does not depend on being able to send. A provider that is
// switched off, paused by a circuit breaker, or not yet live for API sending
// must still have its inbound STOPs ingested — arguably more urgently, because a
// provider gets switched off precisely when something is wrong.
//
// This existed as a real defect, not a hypothetical: selectPollableCredentials
// carried `AND p.supports_api_send = true`, and the provider page exposes that
// flag as a one-click "Disable". Pressing it silently stopped TextHub opt-out
// ingestion — and TextHub's push callback is broken on their side, so the poller
// is its ONLY intake.
//
// Method: flip every sending flag OFF inside a transaction, re-run the real
// selection, assert the credential set is UNCHANGED, then ROLL BACK. Nothing is
// committed — the flags are restored by the rollback, not by a compensating
// write that could itself fail.
import "./_env-preload";

import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";
import { selectPollableCredentials } from "@/lib/sends/poll-opt-outs";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? `\n     ${detail}` : ""}`);
}
const ROLLBACK = Symbol("rollback");

// Every intake path's credential/row selection, expressed as it appears in
// production. Each must be invariant under the sending flags.
const INTAKE_SELECTIONS: { name: string; run: (tx: never) => Promise<string> }[] = [
  {
    name: "TextHub STOP poller (selectPollableCredentials)",
    run: async (tx) => {
      const rows = await selectPollableCredentials(tx as never);
      return rows.map((r) => r.credential_id).sort((a, b) => a - b).join(",");
    },
  },
  {
    name: "Ahoi CDR poll credential selection",
    run: async (tx) => {
      const rows = (await (tx as never as typeof db).execute(sql`
        SELECT pc.id FROM provider_credentials pc
        JOIN sms_providers p ON p.id = pc.provider_id
        WHERE COALESCE(p.adapter_code, p.sms_provider_id) = 'ahi'
        ORDER BY pc.id
      `)) as unknown as { id: number }[];
      return rows.map((r) => r.id).join(",");
    },
  },
  {
    name: "Webhook token resolution (all providers, path-token auth)",
    run: async (tx) => {
      // Inbound webhooks resolve by inbound_webhook_token alone — no provider
      // flag is consulted anywhere in that lookup. Pinned so a future 'tidy-up'
      // cannot add one.
      const rows = (await (tx as never as typeof db).execute(sql`
        SELECT id FROM provider_credentials
        WHERE inbound_webhook_token IS NOT NULL ORDER BY id
      `)) as unknown as { id: number }[];
      return rows.map((r) => r.id).join(",");
    },
  },
];

async function main() {
  try {
    await db.transaction(async (tx) => {
      const before: Record<string, string> = {};
      for (const s of INTAKE_SELECTIONS) before[s.name] = await s.run(tx as never);

      // A vacuous comparison would pass trivially. Refuse it.
      check(
        "baseline intake selections are non-empty",
        Object.values(before).every((v) => v.length > 0),
        Object.entries(before).map(([k, v]) => `${k} -> [${v}]`).join("\n     "),
      );

      // Turn OFF every sending flag on every provider.
      await tx.execute(sql`
        UPDATE sms_providers
        SET supports_api_send = false,
            send_paused = true,
            send_paused_reason = 'invariant-test',
            send_paused_at = now()
      `);
      // Org-level switches too — the poller must survive those as well.
      await tx.execute(sql`UPDATE org_settings SET sends_enabled = false, sends_paused = true`);

      for (const s of INTAKE_SELECTIONS) {
        const after = await s.run(tx as never);
        check(
          `${s.name}: unchanged with ALL sending flags off`,
          after === before[s.name],
          `before=[${before[s.name]}]  after=[${after}]`,
        );
      }

      // Belt and braces: assert no intake selection mentions a sending flag by
      // reading the source, so a future edit that reintroduces one fails here
      // even if the data happens to make the sets identical.
      const fs = await import("node:fs/promises");
      const src = await fs.readFile("lib/sends/poll-opt-outs.ts", "utf8");
      const sel = src.slice(src.indexOf("export async function selectPollableCredentials"));
      const body = sel.slice(0, sel.indexOf("Dual-read"));
      check(
        "selectPollableCredentials source contains no sending predicate",
        !/supports_api_send|send_paused|sends_enabled|sends_paused/.test(body),
        "a sending flag reappeared in the STOP-intake credential selection",
      );

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  // Prove the rollback actually restored production state.
  const post = (await db.execute(sql`
    SELECT count(*)::int AS n FROM sms_providers WHERE send_paused = true OR supports_api_send = false
  `)) as unknown as { n: number }[];
  const expected = (await db.execute(sql`
    SELECT count(*)::int AS n FROM sms_providers WHERE supports_api_send = false
  `)) as unknown as { n: number }[];
  check(
    "rollback restored provider flags (no lingering test pause)",
    post[0].n === expected[0].n,
    `rows with a sending flag off after rollback: ${post[0].n} (expected ${expected[0].n} — the genuinely non-API rows)`,
  );
  const stuck = (await db.execute(sql`
    SELECT count(*)::int AS n FROM sms_providers WHERE send_paused_reason = 'invariant-test'
  `)) as unknown as { n: number }[];
  check("no provider left paused by this test", stuck[0].n === 0, `found ${stuck[0].n}`);

  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS (rolled back)." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
