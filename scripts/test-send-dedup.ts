import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { runStageDrain, type Sender } from "@/lib/sends/drain";

// Verifies the GLOBAL 1-hour send-dedup gate in the drain (migration 0090):
//   1. WITHIN window: a phone already 'sent' < 1h ago (any stage) → its pending
//      row is marked 'skipped_duplicate', NOT sent.
//   2. OUTSIDE window: a phone last 'sent' > 1h ago → sends normally.
//   3. SAME BATCH: two pending rows for the SAME phone (distinct contacts) with no
//      prior send → exactly one sends, the other is skipped_duplicate.
// All in a rolled-back tx (no real TextHub — injected sender). Requires 0090
// (the 'skipped_duplicate' status) to be applied.
//
// Run: npx tsx scripts/test-send-dedup.ts

class Rollback extends Error {}
let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  console.log(`  ${cond ? "✓" : "✗ FAIL"} ${msg}`);
  if (cond) pass++;
  else fail++;
}

const okSender: Sender = async () => ({
  ok: true,
  messageId: "TH-msg",
  response: "queued",
  providerStatus: null,
  suppressed: false,
  rawBody: '{"response":"queued"}',
  error: null,
  status: 200,
  timedOut: false,
});

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db = drizzle(pg);
  try {
    await db.transaction(async (tx) => {
      const one = async <T>(q: Parameters<typeof tx.execute>[0]): Promise<T> =>
        ((await tx.execute(q)) as unknown as T[])[0];

      const orgId = (await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`)).id;
      await tx.execute(sql`
        INSERT INTO org_settings (org_id, sends_enabled) VALUES (${orgId}, true)
        ON CONFLICT (org_id) DO UPDATE SET sends_enabled = true`);
      const brand = await one<{ id: number }>(sql`
        INSERT INTO brands (org_id, brand_id, name) VALUES (${orgId}, ${"dd-brand"}, ${"DD"}) RETURNING id`);
      let cSeq = 0;
      const mkContact = async () =>
        (await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number)
          VALUES (${orgId}, ${`+1560000${String(cSeq++).padStart(4, "0")}`}) RETURNING id`)).id;
      // High caps so the soft rolling ceilings (org-wide 24h/minute send counts)
      // don't trip — this test runs against a real org that may have real sends
      // in the last 24h, which would otherwise stop the drain before it claims.
      const provider = await one<{ id: number }>(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send, status,
                                   max_sends_per_24h, max_sends_per_minute, max_sends_per_run)
        VALUES (${"dd-prov"}, ${orgId}, ${"DD"}, true, 'active',
                ${100_000_000}, ${100_000_000}, ${100_000_000}) RETURNING id`);
      await tx.execute(sql`
        INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key)
        VALUES (${orgId}, ${provider.id}, NULL, ${"key"})`);
      const camp = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, brand_id, link_mode, status)
        VALUES (${orgId}, ${"dd-camp"}, ${brand.id}, 'tracked', 'active') RETURNING id`);
      let sSeq = 0;
      const mkStage = async () =>
        (await one<{ id: number }>(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number, sms_provider_id, send_approved)
          VALUES (${orgId}, ${camp.id}, ${sSeq++}, ${provider.id}, true) RETURNING id`)).id;

      const addRow = async (
        stage: number,
        contactId: string,
        phone: string,
        status: string,
        sentAtSql: ReturnType<typeof sql> | null,
      ) =>
        tx.execute(sql`
          INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
          VALUES (${orgId}, ${camp.id}, ${stage}, ${contactId}, ${phone}, ${"x"}, ${status}, ${sentAtSql})`);
      const cnt = async (stage: number, status: string) =>
        Number((await one<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM stage_sends WHERE stage_id = ${stage} AND status = ${status}`)).n);

      const history = await mkStage(); // holds prior 'sent' rows

      // ---- 1. WITHIN window → skipped_duplicate ----
      console.log("1) phone messaged < 1h ago is SKIPPED:");
      const target1 = await mkStage();
      const cP = await mkContact();
      const cPrior = await mkContact();
      await addRow(history, cPrior, "+19990000001", "sent", sql`now() - interval '10 minutes'`);
      await addRow(target1, cP, "+19990000001", "pending", null);
      const r1 = await runStageDrain(tx, { stageId: target1, sendSms: okSender, isEnabled: () => true });
      assert(r1.ok && r1.skippedDuplicate === 1 && r1.sent === 0, `skippedDuplicate=1 sent=0 (got ${JSON.stringify({ s: r1.sent, sd: r1.skippedDuplicate })})`);
      assert((await cnt(target1, "skipped_duplicate")) === 1, "target row marked skipped_duplicate");
      assert((await cnt(target1, "sent")) === 0, "target row not sent");

      // ---- 2. OUTSIDE window → sends ----
      console.log("2) phone last messaged > 1h ago SENDS:");
      const target2 = await mkStage();
      const cQ = await mkContact();
      const cQprior = await mkContact();
      await addRow(history, cQprior, "+19990000002", "sent", sql`now() - interval '90 minutes'`);
      await addRow(target2, cQ, "+19990000002", "pending", null);
      const r2 = await runStageDrain(tx, { stageId: target2, sendSms: okSender, isEnabled: () => true });
      assert(r2.ok && r2.sent === 1 && r2.skippedDuplicate === 0, `sent=1 skippedDuplicate=0 (got ${JSON.stringify({ s: r2.sent, sd: r2.skippedDuplicate })})`);

      // ---- 3. SAME BATCH duplicate phone → one sends, one skipped ----
      console.log("3) two pending rows, same phone, one batch:");
      const target3 = await mkStage();
      const cR1 = await mkContact();
      const cR2 = await mkContact();
      await addRow(target3, cR1, "+19990000003", "pending", null);
      await addRow(target3, cR2, "+19990000003", "pending", null);
      const r3 = await runStageDrain(tx, { stageId: target3, sendSms: okSender, isEnabled: () => true });
      assert(r3.ok && r3.sent === 1 && r3.skippedDuplicate === 1, `sent=1 skippedDuplicate=1 (got ${JSON.stringify({ s: r3.sent, sd: r3.skippedDuplicate })})`);
      assert((await cnt(target3, "sent")) === 1 && (await cnt(target3, "skipped_duplicate")) === 1, "one sent + one skipped in the stage");

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  } finally {
    await pg.end({ timeout: 5 });
  }
  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}: ${pass} passed, ${fail} failed (rolled back)`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
