import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { createPartnerWithKey } from "./_partner-fixture";

// Schema guard for migration 0228 (partner passthrough + sales postbacks).
// Runs against the preview DB only; everything inside ONE rolled-back transaction.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Runs a statement expected to fail; returns the SQLSTATE (exact, via cause). */
async function sqlstate(tx: Tx, stmt: ReturnType<typeof sql>): Promise<string> {
  await tx.execute(sql`SAVEPOINT probe`);
  let code = "NO-ERROR";
  try {
    await tx.execute(stmt);
  } catch (e) {
    const cause = (e as { cause?: Record<string, unknown> })?.cause;
    code = String(cause?.code ?? (e as { code?: string })?.code ?? "UNKNOWN");
  }
  await tx.execute(sql`ROLLBACK TO SAVEPOINT probe`);
  return code;
}

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}`);

  try {
    await db.transaction(async (tx) => {
      const org = (await tx.execute(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as {
        id: string;
      }[];
      const orgId = org[0]?.id;
      if (!orgId) throw new Error("no organization in the preview database");

      const { keyId } = await createPartnerWithKey(tx, { orgId, slug: `pb-schema-${Date.now()}` });

      // ── M1 columns + defaults ─────────────────────────────────────────
      console.log("\nM1 columns + defaults:");
      const cols = (await tx.execute(sql`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name='partner_keys'
          AND column_name IN ('passthrough_fields','postback_enabled','postback_url_template',
            'postback_include_payout','postback_first_purchase_only','postback_event_keys','postback_active_since')
        ORDER BY column_name`)) as unknown as { column_name: string }[];
      check("7 postback/passthrough key columns exist", cols.length, 7);
      const pd = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema='public' AND table_name IN ('lead_inbox','lead_events') AND column_name='partner_data'`)) as unknown as {
        n: number;
      }[];
      check("partner_data on lead_inbox + lead_events", pd[0].n, 2);
      const k = (await tx.execute(sql`
        SELECT passthrough_fields, postback_enabled, postback_url_template, postback_include_payout,
               postback_first_purchase_only, postback_event_keys::text AS ek, postback_active_since
        FROM partner_keys WHERE id=${keyId}`)) as unknown as Record<string, unknown>[];
      check("fresh key passthrough_fields = []", k[0].passthrough_fields, []);
      check("fresh key postback_enabled = false", k[0].postback_enabled, false);
      check("fresh key template NULL", k[0].postback_url_template, null);
      check("fresh key include_payout = false", k[0].postback_include_payout, false);
      check("fresh key first_purchase_only = false", k[0].postback_first_purchase_only, false);
      check("fresh key postback_event_keys = {purchase}", k[0].ek, "{purchase}");
      check("fresh key active_since NULL", k[0].postback_active_since, null);

      // ── M2 ────────────────────────────────────────────────────────────
      console.log("\nM2 passthrough_fields check:");
      const eleven = JSON.stringify(Array.from({ length: 11 }, (_, i) => `f${i}`));
      check("11-element array ⇒ 23514", await sqlstate(tx, sql`
        UPDATE partner_keys SET passthrough_fields=${eleven}::jsonb WHERE id=${keyId}`), "23514");
      check("non-array ⇒ 23514", await sqlstate(tx, sql`
        UPDATE partner_keys SET passthrough_fields='{"a":1}'::jsonb WHERE id=${keyId}`), "23514");
      const ten = JSON.stringify(Array.from({ length: 10 }, (_, i) => `f${i}`));
      check("10-element array ⇒ OK", await sqlstate(tx, sql`
        UPDATE partner_keys SET passthrough_fields=${ten}::jsonb WHERE id=${keyId}`), "NO-ERROR");

      // ── M3 ────────────────────────────────────────────────────────────
      console.log("\nM3 event_keys check:");
      check("'{registration}' ⇒ 23514", await sqlstate(tx, sql`
        UPDATE partner_keys SET postback_event_keys='{registration}' WHERE id=${keyId}`), "23514");
      check("'{}' ⇒ 23514", await sqlstate(tx, sql`
        UPDATE partner_keys SET postback_event_keys='{}' WHERE id=${keyId}`), "23514");

      // ── M4 ────────────────────────────────────────────────────────────
      console.log("\nM4 enabled needs template:");
      check("enabled + NULL template ⇒ 23514", await sqlstate(tx, sql`
        UPDATE partner_keys SET postback_enabled=true WHERE id=${keyId}`), "23514");
      const long = "https://x.test/" + "a".repeat(2040);
      check("template > 2048 ⇒ 23514", await sqlstate(tx, sql`
        UPDATE partner_keys SET postback_url_template=${long} WHERE id=${keyId}`), "23514");
      check("enabled + template ⇒ OK", await sqlstate(tx, sql`
        UPDATE partner_keys SET postback_enabled=true, postback_url_template='https://x.test/p?c={click_id}' WHERE id=${keyId}`), "NO-ERROR");

      // ── M5 ────────────────────────────────────────────────────────────
      console.log("\nM5 uniqueness:");
      const ceId = ((await tx.execute(sql`
        INSERT INTO conversion_events (org_id, keitaro_event_id, keitaro_status, keitaro_type, occurred_at)
        VALUES (${orgId}::uuid, ${"pbtest-" + Date.now()}, 'sale', 'sale', now())
        RETURNING id`)) as unknown as { id: number }[])[0].id;
      const ins = sql`
        INSERT INTO partner_postbacks (org_id, partner_key_id, conversion_event_id, payload)
        VALUES (${orgId}::uuid, ${keyId}, ${ceId}, '{}'::jsonb)`;
      await tx.execute(ins);
      check("duplicate non-test (key, conversion) ⇒ 23505", await sqlstate(tx, ins), "23505");
      check("deleting a conversion with a postback ⇒ 23503 (RESTRICT)", await sqlstate(tx, sql`
        DELETE FROM conversion_events WHERE id=${ceId}`), "23503");
      const testIns = sql`
        INSERT INTO partner_postbacks (org_id, partner_key_id, is_test, payload)
        VALUES (${orgId}::uuid, ${keyId}, true, '{}'::jsonb)`;
      await tx.execute(testIns);
      check("two is_test rows with NULL conversion ⇒ OK", await sqlstate(tx, testIns), "NO-ERROR");

      // ── M6 ────────────────────────────────────────────────────────────
      console.log("\nM6 status check:");
      for (const s of ["pending", "delivered", "failed", "cancelled"]) {
        check(`status '${s}' accepted`, await sqlstate(tx, sql`
          INSERT INTO partner_postbacks (org_id, partner_key_id, is_test, payload, status)
          VALUES (${orgId}::uuid, ${keyId}, true, '{}'::jsonb, ${s})`), "NO-ERROR");
      }
      check("status 'sent' ⇒ 23514", await sqlstate(tx, sql`
        INSERT INTO partner_postbacks (org_id, partner_key_id, is_test, payload, status)
        VALUES (${orgId}::uuid, ${keyId}, true, '{}'::jsonb, 'sent')`), "23514");

      // ── M7 ────────────────────────────────────────────────────────────
      console.log("\nM7 RLS:");
      const rls = (await tx.execute(sql`
        SELECT relrowsecurity FROM pg_class WHERE relname='partner_postbacks' AND relnamespace='public'::regnamespace`)) as unknown as {
        relrowsecurity: boolean;
      }[];
      check("RLS enabled on partner_postbacks", rls[0]?.relrowsecurity, true);
      const pol = (await tx.execute(sql`
        SELECT cmd FROM pg_policies WHERE schemaname='public' AND tablename='partner_postbacks'`)) as unknown as { cmd: string }[];
      check("only a SELECT policy", pol.map((p) => p.cmd), ["SELECT"]);

      throw new Error("ROLLBACK_SENTINEL");
    });
  } catch (e) {
    if ((e as Error).message !== "ROLLBACK_SENTINEL") {
      failures++;
      console.log(`  FAIL  unexpected error: ${(e as Error).message}`);
    }
  }

  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
