// Bug 3 (primary): the send kickoff must mint the link against the stage's stored
// Full URL — what the operator controls in the UI — not a server-side rebuild.
// Asserts the minted link destination equals full_url exactly. Rolled-back tx.
// Run: npx tsx scripts/test-kickoff-fullurl.ts
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
      // Reuse a brand that already has an ACTIVE short domain (one per brand).
      const brand = await one<{ id: number }>(sql`
        SELECT b.id FROM brands b
        JOIN short_domains sd ON sd.brand_id = b.id AND sd.status = 'active'
        WHERE b.org_id = ${orgId} LIMIT 1`);
      if (!brand) { console.log("SKIP: need a brand with an active short domain"); throw ROLLBACK; }

      const TRACKING = "9_99_061626_1_s1_c1";
      const FULL_URL = `https://www.guidekn.com/lp/knd?sub_id3=${TRACKING}`;

      const prov = await one<{ id: number }>(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send)
        VALUES (${"ku-" + sfx}, ${orgId}, ${"ku"}, true) RETURNING id`);
      await tx.execute(sql`INSERT INTO provider_credentials (org_id, provider_id, brand_id, api_key) VALUES (${orgId}, ${prov.id}, NULL, ${"k"})`);
      const cre = await one<{ id: number }>(sql`INSERT INTO creatives (slug, org_id, text, status) VALUES (${"ku-cre-" + sfx}, ${orgId}, ${"hi {link}"}, 'active') RETURNING id`);
      const camp = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, tracking_id)
        VALUES (${orgId}, ${"ku-camp-" + sfx}, ${"k"}, 'active', 'tracked', ${brand.id}, ${"9_99_061626_1"}) RETURNING id`);
      const campaignId = camp.id;
      const stage = await one<{ id: number }>(sql`
        INSERT INTO campaign_stages
          (org_id, campaign_id, stage_number, creative_id, sms_provider_id, send_approved,
           tracking_id, full_url, include_no_status, stop_text)
        VALUES (${orgId}, ${campaignId}, 1, ${cre.id}, ${prov.id}, true,
           ${TRACKING}, ${FULL_URL}, true, ${"STOP"}) RETURNING id`);
      const stageId = stage.id;

      // One qualifying recipient in the frozen pool (no-status at snapshot).
      const contact = await one<{ id: string }>(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+1555" + sfx}) RETURNING id`);
      await tx.execute(sql`
        INSERT INTO campaign_audience_pool (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot)
        VALUES (${orgId}, ${campaignId}, ${contact.id}, true, false)`);

      const result = await kickoffStageSend(tx as unknown as typeof db, { orgId, campaignId, stageId });
      check("kickoff ok", result.ok, JSON.stringify(result));

      const dest = await one<{ url: string }>(sql`
        SELECT ld.url FROM links l JOIN link_destinations ld ON ld.id = l.destination_id
        WHERE l.stage_id = ${stageId} ORDER BY l.id DESC LIMIT 1`);
      check("minted destination == stored full_url (not a rebuild)", dest?.url === FULL_URL, `got ${dest?.url}`);
      check("destination uses sub_id3, no knd=", !!dest && dest.url.includes("?sub_id3=") && !/[?&]knd=/.test(dest.url), dest?.url);

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nBug 3 — kickoff mints from full_url verified (rolled back)." : `\nFAILED: ${failed}`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
