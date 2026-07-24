import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { db as dbType } from "@/db/client";
import { runSendPreflight } from "@/lib/sends/send-preflight";

// Verifies the P5 send-preflight cron logic (migration 0118):
//   1. A stage scheduled inside the 15-min window is preflighted: breakdown
//      persisted to preflight_result + preflight_notified_at stamped.
//   2. Post-once: a second run does NOT re-notify (considered=0).
//   3. A stage scheduled beyond the window is NOT considered.
//   4. Red detection: a no-audience stage counts in `red`.
// Rolled-back tx (notifyTelegram is a no-op without a token). Requires 0118.
//
// Run: npx tsx scripts/test-send-preflight.ts

class Rollback extends Error {}
let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  console.log(`  ${cond ? "✓" : "✗ FAIL"} ${msg}`);
  if (cond) pass++;
  else fail++;
}

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db = drizzle(pg);
  try {
    await db.transaction(async (tx) => {
      const T = tx as unknown as typeof dbType;
      const one = async <X>(q: Parameters<typeof tx.execute>[0]): Promise<X> =>
        ((await tx.execute(q)) as unknown as X[])[0];

      const orgId = (await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`)).id;
      const brand = await one<{ id: number }>(sql`
        INSERT INTO brands (org_id, brand_id, name) VALUES (${orgId}, ${"pf-b"}, ${"PF"}) RETURNING id`);
      let cc = 0;
      const mkContact = async () => {
        const phone = `+1564000${String(cc++).padStart(4, "0")}`;
        const id = (await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${phone}) RETURNING id`)).id;
        return { id, phone };
      };
      let camp = 0;
      const mkCampaign = async () =>
        (await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, brand_id, link_mode, status)
          VALUES (${orgId}, ${"pf-camp-" + camp++}, ${brand.id}, 'tracked', 'active') RETURNING id`)).id;
      let ss = 0;
      const mkStage = async (campId: number, schedIso: string | null, approved = true) =>
        (await one<{ id: number }>(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, send_approved, scheduled_at, include_no_status, include_clickers, exclude_clickers)
          VALUES (${orgId}, ${campId}, ${ss++}, ${approved}, ${schedIso}, true, true, false) RETURNING id`)).id;
      const addPool = async (campId: number, contactId: string) =>
        tx.execute(sql`
          INSERT INTO campaign_audience_pool (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot, was_opt_in_at_snapshot)
          VALUES (${orgId}, ${campId}, ${contactId}, true, false, false)`);
      const optOut = async (contactId: string, phone: string) =>
        tx.execute(sql`INSERT INTO opt_outs (org_id, contact_id, phone_number, source) VALUES (${orgId}, ${contactId}, ${phone}, 'sms_inbound')`);

      const now = new Date("2026-07-24T18:00:00Z");
      const inWindow = new Date(now.getTime() + 10 * 60 * 1000).toISOString(); // +10 min
      const beyond = new Date(now.getTime() + 40 * 60 * 1000).toISOString(); // +40 min

      // 1. In-window healthy stage
      console.log("1) stage scheduled +10 min → preflighted:");
      const c1 = await mkCampaign();
      const s1 = await mkStage(c1, inWindow);
      await addPool(c1, (await mkContact()).id); await addPool(c1, (await mkContact()).id);
      // 3-fixture: beyond-window stage (should be ignored)
      const c3 = await mkCampaign();
      await mkStage(c3, beyond);
      // 4-fixture: in-window RED stage (sole contact opted out → no audience)
      const c4 = await mkCampaign();
      const s4 = await mkStage(c4, inWindow);
      const oo = await mkContact(); await addPool(c4, oo.id); await optOut(oo.id, oo.phone);

      const r1 = await runSendPreflight(T, { now, orgId });
      assert(r1.considered === 2 && r1.preflighted === 2, `considered=2 preflighted=2 (beyond-window excluded) (got ${r1.considered}/${r1.preflighted})`);
      // Both in-window stages are red: s4 = no audience; s1 = structural blockers
      // (minimal fixture has no creative/provider) — both correct preflight reds.
      assert(r1.red === 2, `red=2 (no-audience + structurally-blocked) (got ${r1.red})`);
      const s1row = await one<{ pr: unknown; notified: string | null }>(sql`
        SELECT preflight_result AS pr, preflight_notified_at AS notified FROM campaign_stages WHERE id = ${s1}`);
      assert(s1row.pr != null && s1row.notified != null, "s1 preflight_result + preflight_notified_at persisted");
      const s4row = await one<{ pr: { red: { no_audience: boolean } } }>(sql`
        SELECT preflight_result AS pr FROM campaign_stages WHERE id = ${s4}`);
      assert(s4row.pr?.red?.no_audience === true, "s4 breakdown flags red.no_audience");

      // 2. Post-once
      console.log("2) second run → post-once (nothing reconsidered):");
      const r2 = await runSendPreflight(T, { now, orgId });
      assert(r2.considered === 0 && r2.preflighted === 0, `considered=0 preflighted=0 (already notified) (got ${r2.considered}/${r2.preflighted})`);

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
