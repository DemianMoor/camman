import "./_require-preview-db"; // MUST be first — refuses any target but the preview DB
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { runStageDrain, type Sender } from "@/lib/sends/drain";

// Verifies the SEND-TIME OPT-OUT INVARIANT in the drain (migration 0116):
// opt-outs are filtered into the frozen stage_sends set only at MATERIALIZATION,
// so a STOP arriving in the materialize→dispatch window must be re-checked at
// dispatch. The drain claim now re-checks opt_outs and marks violators
// 'skipped_opted_out' (+ last_error='opt_out_cancel') — a distinct terminal
// bucket, never sent.
//   1. MATERIALIZED THEN OPTED OUT: a pending row whose contact has an opt_out
//      (recorded after materialization) → 'skipped_opted_out', NOT sent.
//   2. NOT OPTED OUT: a pending row with no opt_out → sends normally.
//   3. OPT-OUT BEATS DEDUP: an opted-out contact whose phone was ALSO messaged
//      < 1h ago lands in 'skipped_opted_out' (opt-out re-check runs before the
//      1-hour dedup gate), NOT 'skipped_duplicate'.
//   4. BLOCKED AFTER MATERIALIZATION (contact blocks, 0237): a pending row whose
//      contact is blocked → 'filtered' / last_error 'blocked_cancel', NOT sent.
//   5. DELETED (archived) AFTER MATERIALIZATION → same.
//   6. OPT-OUT BEATS BLOCK: opted out AND blocked → 'skipped_opted_out'.
// All in a rolled-back tx (no real provider — injected sender). Requires 0116 + 0237.
//
// Run: npx tsx scripts/test-send-optout-invariant.ts

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
        INSERT INTO brands (org_id, brand_id, name) VALUES (${orgId}, ${"oo-brand"}, ${"OO"}) RETURNING id`);
      let cSeq = 0;
      const mkContact = async () =>
        (await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number)
          VALUES (${orgId}, ${`+1561000${String(cSeq++).padStart(4, "0")}`}) RETURNING id`)).id;
      // High caps so the soft rolling ceilings (org-wide 24h/minute counts) don't
      // trip against a real org that may have real sends in the last 24h.
      const provider = await one<{ id: number }>(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send, status,
                                   max_sends_per_24h, max_sends_per_minute, max_sends_per_run)
        VALUES (${"oo-prov"}, ${orgId}, ${"OO"}, true, 'active',
                ${100_000_000}, ${100_000_000}, ${100_000_000}) RETURNING id`);
      await tx.execute(sql`
        INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key)
        VALUES (${orgId}, ${provider.id}, NULL, ${"key"})`);
      const camp = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, brand_id, link_mode, status)
        VALUES (${orgId}, ${"oo-camp"}, ${brand.id}, 'tracked', 'active') RETURNING id`);
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
      const optOut = async (contactId: string, phone: string) =>
        tx.execute(sql`
          INSERT INTO opt_outs (org_id, contact_id, phone_number, source)
          VALUES (${orgId}, ${contactId}, ${phone}, ${"sms_inbound"})`);
      const cnt = async (stage: number, status: string) =>
        Number((await one<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM stage_sends WHERE stage_id = ${stage} AND status = ${status}`)).n);

      const history = await mkStage(); // holds prior 'sent' rows for test 3

      // ---- 1. MATERIALIZED THEN OPTED OUT → skipped_opted_out ----
      console.log("1) pending row, contact opted out after materialization → SUPPRESSED:");
      const target1 = await mkStage();
      const c1 = await mkContact();
      await addRow(target1, c1, "+19991000001", "pending", null);
      await optOut(c1, "+19991000001");
      const r1 = await runStageDrain(tx, { stageId: target1, sendSms: okSender, isEnabled: () => true });
      assert(
        r1.ok && r1.skippedOptedOut === 1 && r1.sent === 0,
        `skippedOptedOut=1 sent=0 (got ${JSON.stringify({ s: r1.sent, soo: r1.skippedOptedOut })})`,
      );
      assert((await cnt(target1, "skipped_opted_out")) === 1, "target row marked skipped_opted_out");
      assert((await cnt(target1, "sent")) === 0, "target row not sent");

      // ---- 2. NOT OPTED OUT → sends ----
      console.log("2) pending row, no opt_out → SENDS:");
      const target2 = await mkStage();
      const c2 = await mkContact();
      await addRow(target2, c2, "+19991000002", "pending", null);
      const r2 = await runStageDrain(tx, { stageId: target2, sendSms: okSender, isEnabled: () => true });
      assert(
        r2.ok && r2.sent === 1 && r2.skippedOptedOut === 0,
        `sent=1 skippedOptedOut=0 (got ${JSON.stringify({ s: r2.sent, soo: r2.skippedOptedOut })})`,
      );

      // ---- 3. OPT-OUT BEATS DEDUP ----
      console.log("3) opted-out contact ALSO messaged < 1h ago → skipped_opted_out, not skipped_duplicate:");
      const target3 = await mkStage();
      const c3 = await mkContact();
      const c3prior = await mkContact();
      await addRow(history, c3prior, "+19991000003", "sent", sql`now() - interval '10 minutes'`);
      await addRow(target3, c3, "+19991000003", "pending", null);
      await optOut(c3, "+19991000003");
      const r3 = await runStageDrain(tx, { stageId: target3, sendSms: okSender, isEnabled: () => true });
      assert(
        r3.ok && r3.skippedOptedOut === 1 && r3.skippedDuplicate === 0 && r3.sent === 0,
        `skippedOptedOut=1 skippedDuplicate=0 sent=0 (got ${JSON.stringify({ s: r3.sent, soo: r3.skippedOptedOut, sd: r3.skippedDuplicate })})`,
      );
      assert((await cnt(target3, "skipped_opted_out")) === 1, "target row is skipped_opted_out (opt-out wins over dedup)");

      // ---- 4–6. CONTACT BLOCKS: send-time re-check (0237, spec §6 C / V7) ----
      const errOf = async (stage: number) =>
        (await one<{ status: string; last_error: string | null }>(sql`
          SELECT status, last_error FROM stage_sends WHERE stage_id = ${stage}`));
      console.log("4) pending row, contact BLOCKED after materialization → filtered / blocked_cancel:");
      const target4 = await mkStage();
      const c4 = await mkContact();
      const c4ok = await mkContact();
      await addRow(target4, c4, "+19991000004", "pending", null);
      await addRow(target4, c4ok, "+19991000014", "pending", null);
      await tx.execute(sql`UPDATE contacts SET blocked_at = now(), block_reason = 'manual' WHERE id = ${c4}`);
      const r4 = await runStageDrain(tx, { stageId: target4, sendSms: okSender, isEnabled: () => true });
      assert(
        r4.ok && r4.filteredBlocked === 1 && r4.sent === 1,
        `filteredBlocked=1 sent=1 — the unblocked row in the same batch still sends (got ${JSON.stringify({ s: r4.sent, fb: r4.filteredBlocked })})`,
      );
      const e4 = (await tx.execute(sql`
        SELECT status, last_error FROM stage_sends WHERE stage_id = ${target4} AND contact_id = ${c4}`)) as unknown as { status: string; last_error: string }[];
      assert(e4[0]?.status === "filtered" && e4[0]?.last_error === "blocked_cancel", `blocked row is filtered/blocked_cancel (got ${JSON.stringify(e4[0])})`);

      console.log("5) pending row, contact DELETED (archived) after materialization → filtered / blocked_cancel:");
      const target5 = await mkStage();
      const c5 = await mkContact();
      await addRow(target5, c5, "+19991000005", "pending", null);
      await tx.execute(sql`UPDATE contacts SET archived_at = now() WHERE id = ${c5}`);
      const r5 = await runStageDrain(tx, { stageId: target5, sendSms: okSender, isEnabled: () => true });
      const e5 = await errOf(target5);
      assert(
        r5.ok && r5.filteredBlocked === 1 && r5.sent === 0 && e5.status === "filtered" && e5.last_error === "blocked_cancel",
        `deleted row is filtered/blocked_cancel, not sent (got ${JSON.stringify({ s: r5.sent, fb: r5.filteredBlocked, ...e5 })})`,
      );

      console.log("6) opted out AND blocked → skipped_opted_out (precedence opt_out > blocked):");
      const target6 = await mkStage();
      const c6 = await mkContact();
      await addRow(target6, c6, "+19991000006", "pending", null);
      await optOut(c6, "+19991000006");
      await tx.execute(sql`UPDATE contacts SET blocked_at = now(), block_reason = 'manual' WHERE id = ${c6}`);
      const r6 = await runStageDrain(tx, { stageId: target6, sendSms: okSender, isEnabled: () => true });
      assert(
        r6.ok && r6.skippedOptedOut === 1 && r6.filteredBlocked === 0 && r6.sent === 0,
        `skippedOptedOut=1 filteredBlocked=0 sent=0 (got ${JSON.stringify({ s: r6.sent, soo: r6.skippedOptedOut, fb: r6.filteredBlocked })})`,
      );

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
