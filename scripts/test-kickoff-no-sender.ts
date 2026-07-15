// G-carry (Section 2 final review): an Ahoi stage with no provider_phone_id
// is refused at KICKOFF, before any recipient materialization — not left to
// fail at drain (which wastes the attempt and risks tripping the failure-
// spike breaker on a purely-configuration problem). TextHub must be
// UNAFFECTED (it doesn't need provider_phone_id — its number is bound to the
// api_key account-side). Rolled-back transaction.
// Run: npx tsx scripts/test-kickoff-no-sender.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { kickoffStageSend } from "@/lib/sends/kickoff";

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

      const ahoiProv = await one<{ id: number }>(sql`SELECT id FROM sms_providers WHERE sms_provider_id = 'ahi'`);
      if (!ahoiProv) { console.log("SKIP: no seeded ahi provider row (run Section 1's seed)."); throw ROLLBACK; }
      await tx.execute(sql`
        INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key)
        VALUES (${orgId}, ${ahoiProv.id}, NULL, 'k') ON CONFLICT DO NOTHING`);

      const texthubProv = await one<{ id: number }>(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send)
        VALUES (${"nosend-th-" + sfx}, ${orgId}, ${"nosend-th"}, true) RETURNING id`);
      await tx.execute(sql`INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key) VALUES (${orgId}, ${texthubProv.id}, NULL, ${"k"})`);

      async function mkStage(opts: { n: number; providerId: number; providerPhoneId: number | null }) {
        const cre = await one<{ id: number }>(sql`
          INSERT INTO creatives (slug, org_id, text, status) VALUES (${"nosend-cre-" + sfx + "-" + opts.n}, ${orgId}, ${"Hi"}, 'active') RETURNING id`);
        const trackingId = `9_99_nosend_${sfx}_s${opts.n}`;
        const camp = await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, tracking_id)
          VALUES (${orgId}, ${"nosend-camp-" + sfx + "-" + opts.n}, ${"nosend"}, 'active', 'tracked', ${brand.id}, ${trackingId}) RETURNING id`);
        const fullUrl = `https://www.guidekn.com/lp/knd?sub_id3=${trackingId}`;
        const stage = await one<{ id: number }>(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, creative_id, sms_provider_id, provider_phone_id, send_approved,
             tracking_id, full_url, include_no_status, stop_text, scheduled_at)
          VALUES (${orgId}, ${camp.id}, ${opts.n}, ${cre.id}, ${opts.providerId}, ${opts.providerPhoneId}, true,
             ${trackingId}, ${fullUrl}, true, ${"STOP"}, now())
          RETURNING id`);
        const contact = await one<{ id: string }>(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+1555" + sfx + opts.n}) RETURNING id`);
        await tx.execute(sql`
          INSERT INTO campaign_audience_pool (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot)
          VALUES (${orgId}, ${camp.id}, ${contact.id}, true, false)`);
        return { stageId: stage.id, campaignId: camp.id };
      }

      // Case A: Ahoi stage, provider_phone_id NULL -> refused.
      const a = await mkStage({ n: 1, providerId: ahoiProv.id, providerPhoneId: null });
      const resA = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId: a.campaignId, stageId: a.stageId });
      check("Ahoi stage with no provider_phone_id -> refused", !resA.ok && resA.reason === "no_sender_number", JSON.stringify(resA));

      // Case B: Ahoi stage, provider_phone_id set -> NOT refused by this guard
      // (may still fail later for unrelated reasons — assert it's not THIS reason).
      const phone = await one<{ id: number }>(sql`
        INSERT INTO provider_phones (org_id, provider_id, phone_number) VALUES (${orgId}, ${ahoiProv.id}, ${"+1900" + sfx}) RETURNING id`);
      const b = await mkStage({ n: 2, providerId: ahoiProv.id, providerPhoneId: phone.id });
      const resB = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId: b.campaignId, stageId: b.stageId });
      check("Ahoi stage WITH provider_phone_id -> not refused by no_sender_number", !(!resB.ok && resB.reason === "no_sender_number"), JSON.stringify(resB));

      // Case C: TextHub stage, provider_phone_id NULL -> NOT refused (TextHub
      // doesn't need a sender number — this is the "don't break TextHub" proof).
      const c = await mkStage({ n: 3, providerId: texthubProv.id, providerPhoneId: null });
      const resC = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId: c.campaignId, stageId: c.stageId });
      check("TextHub stage with no provider_phone_id -> NOT refused (G2 proof)", !(!resC.ok && resC.reason === "no_sender_number"), JSON.stringify(resC));

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
