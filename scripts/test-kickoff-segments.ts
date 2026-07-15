// G8 + spec §4: kickoff refuses a stage whose rendered text (creative + brand
// prefix + tracked link + stop text) crosses into multi-segment territory
// unless the creative opts in (allow_multi_segment=true) — and refuses ANY
// text over MAX_SEGMENTS regardless of that override (the ceiling, G8).
// Mirrors scripts/test-kickoff-fullurl.ts's fixture recipe. Rolled-back tx.
// Run: npx tsx scripts/test-kickoff-segments.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { kickoffStageSend } from "@/lib/sends/kickoff";
import { MAX_SEGMENTS } from "@/lib/sends/segments";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");

async function main() {
  try {
    await db.transaction(async (tx) => {
      const sfx = Date.now().toString().slice(-9);
      const one = async <T>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as T[])[0];
      const org = await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`);
      const orgId = org.id;
      const brand = await one<{ id: number }>(sql`
        SELECT b.id FROM brands b
        JOIN short_domains sd ON sd.brand_id = b.id AND sd.status = 'active'
        WHERE b.org_id = ${orgId} LIMIT 1`);
      if (!brand) { console.log("SKIP: need a brand with an active short domain"); throw ROLLBACK; }

      const prov = await one<{ id: number }>(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send)
        VALUES (${"kseg-" + sfx}, ${orgId}, ${"kseg"}, true) RETURNING id`);
      await tx.execute(sql`INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key) VALUES (${orgId}, ${prov.id}, NULL, ${"k"})`);

      const camp = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, tracking_id)
        VALUES (${orgId}, ${"kseg-camp-" + sfx}, ${"kseg"}, 'active', 'tracked', ${brand.id}, ${"9_99_kseg_" + sfx}) RETURNING id`);
      const campaignId = camp.id;

      // Build one stage per case: a fresh creative + contact + audience-pool
      // row + stage, so each case's kickoff runs against an UNmaterialized
      // stage (materialized_at gates a re-run to a no-op, so cases can't
      // share a stage). full_url is set directly (Bug-3 pattern from
      // test-kickoff-fullurl.ts) so kickoff doesn't need an offer/sales-page.
      async function mkCase(opts: { n: number; text: string; allowMultiSegment: boolean }) {
        const cre = await one<{ id: number }>(sql`
          INSERT INTO creatives (slug, org_id, text, status, allow_multi_segment)
          VALUES (${"kseg-cre-" + sfx + "-" + opts.n}, ${orgId}, ${opts.text}, 'active', ${opts.allowMultiSegment})
          RETURNING id`);
        const trackingId = `9_99_kseg_${sfx}_s${opts.n}`;
        const fullUrl = `https://www.guidekn.com/lp/knd?sub_id3=${trackingId}`;
        const stage = await one<{ id: number }>(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, creative_id, sms_provider_id, send_approved,
             tracking_id, full_url, include_no_status, stop_text, scheduled_at)
          VALUES (${orgId}, ${campaignId}, ${opts.n}, ${cre.id}, ${prov.id}, true,
             ${trackingId}, ${fullUrl}, true, ${"STOP"}, now())
          RETURNING id`);
        const contact = await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+1555" + sfx + opts.n}) RETURNING id`);
        await tx.execute(sql`
          INSERT INTO campaign_audience_pool (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot)
          VALUES (${orgId}, ${campaignId}, ${contact.id}, true, false)`);
        return stage.id;
      }

      // Case A: short text, override off -> 1 segment, sends fine.
      const stageA = await mkCase({ n: 1, text: "Hi", allowMultiSegment: false });
      const resA = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId, stageId: stageA });
      check("short text (1 segment) sends regardless of the override", resA.ok, JSON.stringify(resA));

      // Case B: long text (2 segments, well under the ceiling), override OFF -> refused.
      const stageB = await mkCase({ n: 2, text: "A".repeat(200), allowMultiSegment: false });
      const resB = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId, stageId: stageB });
      check(
        "multi-segment text refused when the creative's override is off",
        !resB.ok && resB.reason === "multi_segment_not_allowed",
        JSON.stringify(resB),
      );

      // Case C: same long text, override ON -> allowed.
      const stageC = await mkCase({ n: 3, text: "A".repeat(200), allowMultiSegment: true });
      const resC = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId, stageId: stageC });
      check("same multi-segment text sends once the creative's override is on", resC.ok, JSON.stringify(resC));

      // Case D: extreme text (over MAX_SEGMENTS), override ON -> STILL refused (G8 ceiling).
      const stageD = await mkCase({ n: 4, text: "A".repeat(800), allowMultiSegment: true });
      const resD = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId, stageId: stageD });
      check(
        `text over ${MAX_SEGMENTS} segments is refused even with the override on (G8 ceiling)`,
        !resD.ok && resD.reason === "segment_ceiling_exceeded",
        JSON.stringify(resD),
      );

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS (rolled back)." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
