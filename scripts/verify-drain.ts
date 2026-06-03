import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { decideDrainAuth, runStageDrain, type Sender } from "@/lib/sends/drain";

// Verifies the real-send drain WITHOUT a real TextHub call (injected sender)
// and WITHOUT persisting (rolled-back tx): both gates (send_approved +
// SEND_ENABLED) block, claim→sent / claim→failed transitions, texthub_message_id
// capture, stuck-in-'sending' is never auto-retried, and the between-batch
// kill-switch halt.
//
// Run: npx tsx scripts/verify-drain.ts

class Rollback extends Error {}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const okSender: Sender = async () => ({
  ok: true,
  messageId: "TH-msg-1",
  response: "queued",
  error: null,
  status: 200,
});
const failSender: Sender = async () => ({
  ok: false,
  messageId: null,
  response: null,
  error: "boom",
  status: 500,
});

async function main() {
  // Dual-auth gate (pure) — confirm there's NO gap between the cron path and
  // the session path: a request with neither a valid Bearer nor a privileged
  // session must be rejected.
  console.log("Drain dual-auth (no gap):");
  assert(
    decideDrainAuth({ bearerMatches: true, sessionRole: null }).allow,
    "valid CRON_SECRET Bearer → allowed (cron)",
  );
  const noAuth = decideDrainAuth({ bearerMatches: false, sessionRole: null });
  assert(!noAuth.allow && noAuth.status === 401, "no Bearer + no session → 401 (no gap)");
  const operator = decideDrainAuth({ bearerMatches: false, sessionRole: "operator" });
  assert(!operator.allow && operator.status === 403, "operator session (no campaigns.drain) → 403");
  assert(
    decideDrainAuth({ bearerMatches: false, sessionRole: "manager" }).allow,
    "manager session → allowed (session)",
  );
  const viewer = decideDrainAuth({ bearerMatches: false, sessionRole: "viewer" });
  assert(!viewer.allow && viewer.status === 403, "viewer session → 403");

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);
  let failed = false;

  try {
    await db.transaction(async (tx) => {
      const one = async <T>(q: ReturnType<typeof sql>) =>
        ((await tx.execute(q)) as unknown as T[])[0];

      const org = await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`);
      if (!org) { console.log("SKIP: no organizations."); throw new Rollback(); }
      const orgId = org.id;
      const brand = await one<{ id: number }>(sql`SELECT id FROM brands WHERE org_id = ${orgId} LIMIT 1`);
      const contact = await one<{ id: string }>(sql`SELECT id FROM contacts WHERE org_id = ${orgId} LIMIT 1`);
      if (!brand || !contact) { console.log("SKIP: need a brand + a contact."); throw new Rollback(); }

      const prov = await one<{ id: number }>(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send, status)
        VALUES (${"vd-prov"}, ${orgId}, ${"VD"}, true, 'active') RETURNING id
      `);
      await tx.execute(sql`INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key) VALUES (${orgId}, ${prov.id}, NULL, ${"key"})`);
      const camp = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, brand_id, link_mode, status)
        VALUES (${orgId}, ${"vd-camp"}, ${brand.id}, 'tracked', 'active') RETURNING id
      `);
      const stage = await one<{ id: number }>(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, sms_provider_id, send_approved)
        VALUES (${orgId}, ${camp.id}, 1, ${prov.id}, false) RETURNING id
      `);
      const stageId = stage.id;

      const addPending = async (text: string) =>
        tx.execute(sql`
          INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
          VALUES (${orgId}, ${camp.id}, ${stageId}, ${contact.id}, ${"+15555550000"}, ${text}, 'pending')
        `);
      const statusOf = async (predicate: string) =>
        Number((await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM stage_sends WHERE stage_id = ${stageId} AND status = ${predicate}`)).n);

      console.log("Gate: not approved");
      await addPending("m1");
      const g1 = await runStageDrain(tx, { stageId, sendSms: okSender, isEnabled: () => true });
      assert(!g1.ok && g1.reason === "not_approved", "unapproved stage refused");
      assert((await statusOf("pending")) === 1, "nothing claimed while unapproved");

      await tx.execute(sql`UPDATE campaign_stages SET send_approved = true WHERE id = ${stageId}`);

      console.log("Gate: SEND_ENABLED off");
      const g2 = await runStageDrain(tx, { stageId, sendSms: okSender, isEnabled: () => false });
      assert(!g2.ok && g2.reason === "send_disabled", "kill-switch off refuses");
      assert((await statusOf("pending")) === 1, "nothing claimed while disabled");

      console.log("Happy path (sent + message id):");
      const h = await runStageDrain(tx, { stageId, sendSms: okSender, isEnabled: () => true });
      assert(h.ok && h.sent === 1 && h.failed === 0, "1 sent");
      const sentRow = await one<{ status: string; texthub_message_id: string | null; sent_at: string | null; attempts: number }>(
        sql`SELECT status, texthub_message_id, sent_at, attempts FROM stage_sends WHERE stage_id = ${stageId} AND status = 'sent' LIMIT 1`,
      );
      assert(sentRow.texthub_message_id === "TH-msg-1", "texthub_message_id captured");
      assert(sentRow.sent_at !== null && sentRow.attempts === 1, "sent_at set, attempts=1");

      console.log("Failure path:");
      await addPending("m2");
      const f = await runStageDrain(tx, { stageId, sendSms: failSender, isEnabled: () => true });
      assert(f.ok && f.failed === 1 && f.sent === 0, "1 failed");
      const failRow = await one<{ last_error: string | null; attempts: number }>(
        sql`SELECT last_error, attempts FROM stage_sends WHERE stage_id = ${stageId} AND status = 'failed' LIMIT 1`,
      );
      assert(failRow.last_error === "boom" && failRow.attempts === 1, "last_error set, attempts=1");

      console.log("Stuck in 'sending' is never auto-retried:");
      await tx.execute(sql`
        INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
        VALUES (${orgId}, ${camp.id}, ${stageId}, ${contact.id}, ${"+15555550001"}, ${"stuck"}, 'sending')
      `);
      const s = await runStageDrain(tx, { stageId, sendSms: okSender, isEnabled: () => true });
      assert(s.ok && s.processed === 0, "no pending rows → nothing processed");
      assert(s.stuck === 1, "stuck 'sending' row surfaced in stuck count");
      assert((await statusOf("sending")) === 1, "stuck row left untouched (not retried)");

      console.log("Between-batch halt:");
      await addPending("b1");
      await addPending("b2");
      await addPending("b3");
      let calls = 0;
      // true for the initial gate + first two batch checks, then off.
      const flip = () => {
        calls++;
        return calls <= 3;
      };
      const hh = await runStageDrain(tx, { stageId, sendSms: okSender, isEnabled: flip, batchSize: 1 });
      assert(hh.ok && hh.halted === true, "halted mid-drain when kill-switch flipped");
      assert(hh.sent >= 1 && hh.remaining >= 1, "some sent before halt, some pending left untouched");

      console.log("\nAll assertions passed. Rolling back (no data persisted).");
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) { console.error("\nVerification FAILED:", err); failed = true; }
  } finally {
    await pg.end({ timeout: 5 });
  }

  if (failed) process.exit(1);
  console.log("verify-drain OK.");
}

main().catch((err) => { console.error("verify-drain crashed:", err); process.exit(1); });
