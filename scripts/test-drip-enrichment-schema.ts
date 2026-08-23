import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";

// Schema guard for the Drip Phase 3 enrichment tables (0155-0158).
//
// ⭐ WHERE IT RUNS. This WRITES, so per docs/07-conventions.md it runs against
// the disposable camman-v2 preview database, never production. It refuses by
// PROJECT REF, which is in the connection string and so cannot be bypassed by
// forgetting an env var.
//
//   DATABASE_URL=<camman-v2 url> npx tsx scripts/test-drip-enrichment-schema.ts
//
// ⭐ THE TWO SECTIONS THAT MATTER MOST:
//
// 1. The LANDLINE SURVIVAL case. Landline leads are counted and then deleted
//    from lead_inbox. If lead_events.inbox_id cascaded instead of SET NULL, that
//    delete would take the lead event with it — destroying the exact evidence
//    the ledger exists to keep. Asserted by deleting the inbox row and checking
//    the event is STILL THERE with a nulled pointer.
//
// 2. The MIXED-QUEUE priority check (ruling G22). It is not enough that drip
//    goes first: the ordering AMONG existing bulk rows must be BYTE-IDENTICAL to
//    today, or this migration silently reorders every other consumer of the
//    lookup queue. So the test claims from a mixed queue and compares the bulk
//    subsequence against the same query with the OLD ordering.

const PROD_REF = "rtdarhkkjwcetlmruftl";
const PREVIEW_REF = "fdzxzxayhknywvmrhjcj";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function expectReject(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  label: string,
  stmt: ReturnType<typeof sql>,
  expectedCode: string,
) {
  await tx.execute(sql`SAVEPOINT probe`);
  let code = "NO-ERROR";
  let constraint = "";
  try {
    await tx.execute(stmt);
  } catch (e) {
    // Drizzle wraps the driver error: the SQLSTATE is on .cause.code, not .code.
    const cause = (e as { cause?: Record<string, unknown> })?.cause;
    code = String(cause?.code ?? (e as { code?: string })?.code ?? "UNKNOWN");
    constraint = String(cause?.constraint_name ?? "");
  }
  await tx.execute(sql`ROLLBACK TO SAVEPOINT probe`);
  check(label, code, expectedCode);
  if (constraint) console.log(`        via constraint ${constraint}`);
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const ref = /postgres\.([a-z0-9]+):/.exec(url)?.[1] ?? "(unknown)";
  if (ref === PROD_REF) {
    console.error(`REFUSING to run against PRODUCTION (${PROD_REF}). This test writes.`);
    process.exit(1);
  }
  console.log(`target project ref: ${ref}${ref === PREVIEW_REF ? "  (camman-v2 preview ✓)" : ""}`);

  console.log("\nschema (0155-0158):");
  const t = (await db.execute(sql`
    SELECT to_regclass('public.lead_events')::text       AS lead_events,
           to_regclass('public.lead_intake_daily')::text AS lead_intake_daily
  `)) as unknown as Record<string, string | null>[];
  for (const [k, v] of Object.entries(t[0])) check(`${k} exists`, !!v, true);

  const cols = (await db.execute(sql`
    SELECT column_name, column_default FROM information_schema.columns
    WHERE table_schema='public' AND (
      (table_name='lookup_settings' AND column_name IN ('drip_daily_cap','balance_floor_usd')) OR
      (table_name='lookup_queue'    AND column_name = 'priority'))
    ORDER BY column_name
  `)) as unknown as { column_name: string; column_default: string }[];
  check("three new columns exist", cols.length, 3);
  for (const c of cols) console.log(`        ${c.column_name} default ${c.column_default}`);
  check(
    "lookup_queue.priority defaults to 0 (today's behaviour preserved)",
    cols.find((c) => c.column_name === "priority")?.column_default,
    "0",
  );

  const rls = (await db.execute(sql`
    SELECT relname, relrowsecurity FROM pg_class
    WHERE relname IN ('lead_events','lead_intake_daily')
      AND relnamespace='public'::regnamespace ORDER BY relname
  `)) as unknown as { relname: string; relrowsecurity: boolean }[];
  for (const r of rls) check(`RLS enabled on ${r.relname}`, r.relrowsecurity, true);
  const pol = (await db.execute(sql`
    SELECT tablename, count(*)::int AS n FROM pg_policies
    WHERE schemaname='public' AND tablename IN ('lead_events','lead_intake_daily')
    GROUP BY 1 ORDER BY 1
  `)) as unknown as { tablename: string; n: number }[];
  check("both new tables carry exactly one SELECT policy", pol.map((p) => p.n), [1, 1]);

  let rolledBack = false;
  try {
    await db.transaction(async (tx) => {
      const org = (await tx.execute(sql`
        SELECT id FROM organizations ORDER BY created_at LIMIT 1
      `)) as unknown as { id: string }[];
      const orgId = org[0]?.id;
      if (!orgId) throw new Error("no organization in the preview database");
      const uniq = String(Date.now()).slice(-7);

      const keyId = ((await tx.execute(sql`
        INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash)
        VALUES (${orgId}, ${"p3-" + uniq}, 'p3 probe', ${"tok3_" + uniq}, 'h')
        RETURNING id`)) as unknown as { id: number }[])[0].id;

      // ── 0155: the widened CHECKs ────────────────────────────────────────
      console.log("\n0155 — widened CHECK constraints:");
      const awaiting = (await tx.execute(sql`
        INSERT INTO lead_inbox (org_id, partner_key_id, partner_slug, raw, status)
        VALUES (${orgId}, ${keyId}, 'p3', '{}'::jsonb, 'awaiting_lookup')
        RETURNING id, status`)) as unknown as { id: string; status: string }[];
      check("lead_inbox accepts 'awaiting_lookup'", awaiting[0]?.status, "awaiting_lookup");
      await expectReject(tx, "lead_inbox still rejects an unknown status", sql`
        INSERT INTO lead_inbox (org_id, partner_key_id, partner_slug, raw, status)
        VALUES (${orgId}, ${keyId}, 'p3', '{}'::jsonb, 'in_flight')`, "23514");

      const batch = (await tx.execute(sql`
        INSERT INTO lookup_batches (org_id, trigger, total_numbers, cache_hits, status)
        VALUES (${orgId}, 'drip_intake', 1, 0, 'pending') RETURNING id, trigger`)) as unknown as
        { id: string; trigger: string }[];
      check("lookup_batches accepts 'drip_intake'", batch[0]?.trigger, "drip_intake");
      await expectReject(tx, "lookup_batches still rejects an unknown trigger", sql`
        INSERT INTO lookup_batches (org_id, trigger, total_numbers, cache_hits, status)
        VALUES (${orgId}, 'telepathy', 1, 0, 'pending')`, "23514");

      // ── 0156: lead_events replay-idempotency + landline survival ────────
      console.log("\n0156 — lead_events:");
      const contactId = ((await tx.execute(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+1997" + uniq})
        RETURNING id`)) as unknown as { id: string }[])[0].id;
      const inboxId = awaiting[0].id;

      const mkEvent = async () =>
        ((await tx.execute(sql`
          INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug,
                                   received_at, inbox_id, line_type)
          VALUES (${orgId}, ${contactId}, ${keyId}, 'p3', now(), ${inboxId}, 'mobile')
          ON CONFLICT (inbox_id) WHERE inbox_id IS NOT NULL DO NOTHING
          RETURNING id`)) as unknown as { id: string }[]);

      const e1 = await mkEvent();
      check("first event inserts", e1.length, 1);
      const e2 = await mkEvent();
      check("⭐ replay of the SAME inbox row is a no-op (crash-safe sweeper)", e2.length, 0);

      // Two events with NULL inbox_id must coexist — the partial index must not
      // collapse them.
      for (const _ of [1, 2]) {
        await tx.execute(sql`
          INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, received_at, inbox_id)
          VALUES (${orgId}, ${contactId}, ${keyId}, 'p3', now(), NULL)`);
      }
      const nulls = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM lead_events WHERE contact_id = ${contactId} AND inbox_id IS NULL
      `)) as unknown as { n: number }[];
      check("NULL inbox_id events coexist (partial index)", nulls[0]?.n, 2);

      // ⭐ THE LANDLINE CASE: delete the inbox row, the event must SURVIVE.
      await tx.execute(sql`DELETE FROM lead_inbox WHERE id = ${inboxId}`);
      const survived = (await tx.execute(sql`
        SELECT id, inbox_id FROM lead_events WHERE id = ${e1[0].id}
      `)) as unknown as { id: string; inbox_id: string | null }[];
      check("⭐ event SURVIVES deletion of its lead_inbox row", survived.length, 1);
      check("⭐ inbox_id was SET NULL, not cascaded away", survived[0]?.inbox_id, null);

      // ── 0157: the counter ───────────────────────────────────────────────
      console.log("\n0157 — lead_intake_daily:");
      const bump = async (colName: string, n: number) =>
        ((await tx.execute(sql`
          INSERT INTO lead_intake_daily (org_id, partner_key_id, day_et, ${sql.raw(colName)})
          VALUES (${orgId}, ${keyId}, '2026-08-23'::date, ${n})
          ON CONFLICT (partner_key_id, day_et)
          DO UPDATE SET ${sql.raw(colName)} = lead_intake_daily.${sql.raw(colName)} + ${n}
          RETURNING ${sql.raw(colName)} AS v`)) as unknown as { v: number }[])[0].v;

      check("received increments from nothing", await bump("received", 3), 3);
      check("received accumulates", await bump("received", 2), 5);
      check("voip counted separately (G19)", await bump("voip", 1), 1);
      check("unknown counted separately (G19)", await bump("unknown", 4), 4);
      check("landline counted", await bump("landline", 7), 7);
      check("sandbox counted", await bump("sandbox", 9), 9);
      check("lookups_spent counted", await bump("lookups_spent", 2), 2);
      await expectReject(tx, "a negative counter is rejected", sql`
        UPDATE lead_intake_daily SET mobile = -1
        WHERE partner_key_id = ${keyId} AND day_et = '2026-08-23'::date`, "23514");

      // ── 0158 / G22: the mixed-queue ordering check ──────────────────────
      console.log("\n0158 / G22 — mixed-queue claim ordering:");
      const bulkBatch = ((await tx.execute(sql`
        INSERT INTO lookup_batches (org_id, trigger, total_numbers, cache_hits, status)
        VALUES (${orgId}, 'upload', 6, 0, 'pending') RETURNING id`)) as unknown as { id: string }[])[0].id;

      // Six bulk rows at the default priority, inserted with ascending
      // created_at so their relative order is well defined and observable.
      for (let i = 0; i < 6; i++) {
        await tx.execute(sql`
          INSERT INTO lookup_queue (batch_id, phone, status, created_at)
          VALUES (${bulkBatch}, ${"+1900" + uniq + i}, 'pending',
                  now() + make_interval(secs => ${i}))`);
      }
      // Two drip rows enqueued LAST (latest created_at) but at higher priority.
      for (let i = 0; i < 2; i++) {
        await tx.execute(sql`
          INSERT INTO lookup_queue (batch_id, phone, status, priority, created_at)
          VALUES (${batch[0].id}, ${"+1901" + uniq + i}, 'pending', 100,
                  now() + make_interval(secs => ${100 + i}))`);
      }

      const newOrder = (await tx.execute(sql`
        SELECT phone, priority FROM lookup_queue
        WHERE batch_id IN (${bulkBatch}::uuid, ${batch[0].id}::uuid) AND status = 'pending'
        ORDER BY priority DESC, created_at, id
      `)) as unknown as { phone: string; priority: number }[];

      check("drip rows are claimed FIRST despite arriving last", newOrder.slice(0, 2).map((r) => r.priority), [100, 100]);

      // ⭐ The claim that protects every other consumer: among the BULK rows,
      // the order under the new query must equal the order under the OLD one.
      const oldOrderBulk = (await tx.execute(sql`
        SELECT phone FROM lookup_queue
        WHERE batch_id = ${bulkBatch} AND status = 'pending'
        ORDER BY created_at, id
      `)) as unknown as { phone: string }[];
      const newOrderBulk = newOrder.filter((r) => r.priority === 0).map((r) => r.phone);
      check(
        "⭐ bulk order AMONG ITSELF is byte-identical to the old ordering",
        newOrderBulk,
        oldOrderBulk.map((r) => r.phone),
      );
      check("all 6 bulk rows still present", newOrderBulk.length, 6);

      tx.rollback();
    });
  } catch (e) {
    const ctor = (e as { constructor?: { name?: string } })?.constructor?.name;
    if (ctor === "TransactionRollbackError") rolledBack = true;
    else throw e;
  }

  check("probe transaction rolled back", rolledBack, true);
  const residue = (await db.execute(sql`
    SELECT (SELECT count(*)::int FROM lead_events)       AS events,
           (SELECT count(*)::int FROM lead_intake_daily) AS daily,
           (SELECT count(*)::int FROM lookup_queue WHERE priority > 0) AS prio_rows
  `)) as unknown as { events: number; daily: number; prio_rows: number }[];
  check("no probe lead_events left behind", residue[0]?.events, 0);
  check("no probe counters left behind", residue[0]?.daily, 0);
  check("no probe queue rows left behind", residue[0]?.prio_rows, 0);

  await pgConn.end({ timeout: 5 });
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
