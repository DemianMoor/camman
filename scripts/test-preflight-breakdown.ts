import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { db as dbType } from "@/db/client";
import { computePreflightBreakdown } from "@/lib/sends/preflight-breakdown";

// Verifies the P5/P6 preflight breakdown (migration 0118) — especially the
// NET-NEW pieces the digest/autopilot rely on:
//   1. Baseline: fresh pool → materialized = pool, predicted = materialized, no excl.
//   2. 1-hour dedup prediction: a recipient whose phone was 'sent' <1h ago is
//      counted in dedup_1h_predicted and dropped from predicted_sends.
//   3. 100% dedup (RED): every recipient dedup-predicted → predicted_sends=0,
//      red.all_dedup_predicted=true (the smoke-test nuance, surfaced pre-fire).
//   4. Opt-out exclusion bucket + predicted reflects it.
//   5. No audience (RED): all excluded → materialized=0, red.no_audience=true.
//   6. Lane exclusion: a tier-0 child counts non-alive parent contacts as lane-
//      excluded (parent 'sent' >1h ago → alive but NOT dedup-predicted).
// Rolled-back tx, no real provider. Requires migration 0118.
//
// Run: npx tsx scripts/test-preflight-breakdown.ts

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
        INSERT INTO brands (org_id, brand_id, name) VALUES (${orgId}, ${"pb-b"}, ${"PB"}) RETURNING id`);
      let cSeq = 0;
      const mkContact = async () => {
        const phone = `+1563000${String(cSeq++).padStart(4, "0")}`;
        const id = (await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${phone}) RETURNING id`)).id;
        return { id, phone };
      };
      let campSeq = 0;
      const mkCampaign = async () =>
        (await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, brand_id, link_mode, status)
          VALUES (${orgId}, ${"pb-camp-" + campSeq++}, ${brand.id}, 'tracked', 'active') RETURNING id`)).id;
      let sSeq = 0;
      const mkStage = async (campId: number, tier: number | null = null, parent: number | null = null) =>
        (await one<{ id: number }>(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, send_approved, include_no_status, include_clickers, exclude_clickers, behavioral_tier, parent_stage_id)
          VALUES (${orgId}, ${campId}, ${sSeq++}, true, true, true, false, ${tier}, ${parent}) RETURNING id`)).id;
      const addPool = async (campId: number, contactId: string) =>
        tx.execute(sql`
          INSERT INTO campaign_audience_pool (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot, was_opt_in_at_snapshot)
          VALUES (${orgId}, ${campId}, ${contactId}, true, false, false)`);
      const addSend = async (campId: number, stageId: number, contactId: string, phone: string, sentAgo: string) =>
        tx.execute(sql`
          INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
          VALUES (${orgId}, ${campId}, ${stageId}, ${contactId}, ${phone}, ${"x"}, 'sent', now() - ${sentAgo}::interval)`);
      const optOut = async (contactId: string, phone: string) =>
        tx.execute(sql`INSERT INTO opt_outs (org_id, contact_id, phone_number, source) VALUES (${orgId}, ${contactId}, ${phone}, 'sms_inbound')`);

      // ── 1. Baseline ─────────────────────────────────────────────────────────
      console.log("1) baseline: 2 fresh contacts, no exclusions:");
      const c1 = await mkCampaign();
      const s1 = await mkStage(c1);
      const a = await mkContact(); const b = await mkContact();
      await addPool(c1, a.id); await addPool(c1, b.id);
      const b1 = await computePreflightBreakdown(T, { orgId, campaignId: c1, stageId: s1 });
      assert(b1.materialized_audience === 2, `materialized=2 (got ${b1.materialized_audience})`);
      assert(b1.predicted_sends === 2 && b1.excluded.dedup_1h_predicted === 0, `predicted=2, dedup=0 (got ${b1.predicted_sends}/${b1.excluded.dedup_1h_predicted})`);
      assert(!b1.red.no_audience && !b1.red.all_dedup_predicted, "no red conditions");

      // ── 2. 1-hour dedup prediction ─────────────────────────────────────────
      console.log("2) one recipient messaged <1h ago → dedup-predicted:");
      const c2 = await mkCampaign();
      const hist2 = await mkStage(c2);
      const s2 = await mkStage(c2);
      const d = await mkContact(); const e = await mkContact();
      await addPool(c2, d.id); await addPool(c2, e.id);
      await addSend(c2, hist2, d.id, d.phone, "20 minutes"); // d messaged 20m ago
      const b2 = await computePreflightBreakdown(T, { orgId, campaignId: c2, stageId: s2 });
      assert(b2.materialized_audience === 2, `materialized=2 (got ${b2.materialized_audience})`);
      assert(b2.excluded.dedup_1h_predicted === 1 && b2.predicted_sends === 1, `dedup=1 predicted=1 (got ${b2.excluded.dedup_1h_predicted}/${b2.predicted_sends})`);

      // ── 3. 100% dedup → RED ────────────────────────────────────────────────
      console.log("3) BOTH recipients messaged <1h ago → 100% dedup RED:");
      const c3 = await mkCampaign();
      const hist3 = await mkStage(c3);
      const s3 = await mkStage(c3);
      const f = await mkContact(); const g = await mkContact();
      await addPool(c3, f.id); await addPool(c3, g.id);
      await addSend(c3, hist3, f.id, f.phone, "10 minutes");
      await addSend(c3, hist3, g.id, g.phone, "40 minutes");
      const b3 = await computePreflightBreakdown(T, { orgId, campaignId: c3, stageId: s3 });
      assert(b3.excluded.dedup_1h_predicted === 2 && b3.predicted_sends === 0, `dedup=2 predicted=0 (got ${b3.excluded.dedup_1h_predicted}/${b3.predicted_sends})`);
      assert(b3.red.all_dedup_predicted === true, "red.all_dedup_predicted = true");

      // ── 4. Opt-out bucket ──────────────────────────────────────────────────
      console.log("4) one contact opted out → opt_out bucket:");
      const c4 = await mkCampaign();
      const s4 = await mkStage(c4);
      const h = await mkContact(); const i = await mkContact();
      await addPool(c4, h.id); await addPool(c4, i.id);
      await optOut(h.id, h.phone);
      const b4 = await computePreflightBreakdown(T, { orgId, campaignId: c4, stageId: s4 });
      assert(b4.excluded.opt_out === 1 && b4.materialized_audience === 1 && b4.predicted_sends === 1, `opt_out=1 materialized=1 predicted=1 (got ${b4.excluded.opt_out}/${b4.materialized_audience}/${b4.predicted_sends})`);

      // ── 5. No audience → RED ───────────────────────────────────────────────
      console.log("5) sole contact opted out → no audience RED:");
      const c5 = await mkCampaign();
      const s5 = await mkStage(c5);
      const j = await mkContact();
      await addPool(c5, j.id);
      await optOut(j.id, j.phone);
      const b5 = await computePreflightBreakdown(T, { orgId, campaignId: c5, stageId: s5 });
      assert(b5.materialized_audience === 0 && b5.red.no_audience === true, `materialized=0 red.no_audience=true (got ${b5.materialized_audience}/${b5.red.no_audience})`);

      // ── 6. Lane exclusion ──────────────────────────────────────────────────
      console.log("6) tier-0 child: non-alive parent contact counts as lane-excluded:");
      const c6 = await mkCampaign();
      const parent6 = await mkStage(c6);
      const child6 = await mkStage(c6, 0, parent6); // Ignored lane
      const k = await mkContact(); const l = await mkContact();
      await addPool(c6, k.id); await addPool(c6, l.id);
      await addSend(c6, parent6, k.id, k.phone, "2 hours"); // k alive (sent), but >1h so NOT dedup-predicted
      const b6 = await computePreflightBreakdown(T, { orgId, campaignId: c6, stageId: child6 });
      assert(b6.materialized_audience === 1, `child materialized=1 (alive K only) (got ${b6.materialized_audience})`);
      assert(b6.excluded.lane === 1, `lane-excluded=1 (L not alive) (got ${b6.excluded.lane})`);
      assert(b6.excluded.dedup_1h_predicted === 0 && b6.predicted_sends === 1, `dedup=0 predicted=1 (parent send >1h) (got ${b6.excluded.dedup_1h_predicted}/${b6.predicted_sends})`);

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
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
