import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { randomUUID } from "node:crypto";

import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { campaignTierExpr } from "../lib/campaign-tier";

// Unit test for campaignTierExpr() against SEEDED synthetic data — the live
// click/send tables are empty, so every signal here is created by this script
// and torn down at the end. No API, no auth: seed → run the real fragment →
// assert → delete everything created.
//
// Covers: no activity → 0; clicked → 1; clicked+reached → 2 (high-water);
// reached+sale → 3; dirty (bot/prefetch/suspect) click only → 0; activity in a
// DIFFERENT campaign → 0 here (scoping); clicked here + sale elsewhere → 1 here.
// Plus: an 'unknown'-classification click counts as clean (→ 1), and the
// cross-campaign contacts read their real tier in the OTHER campaign.

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set in .env.local");
    process.exit(1);
  }

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  let passed = 0;
  let failed = 0;
  function check(name: string, condition: boolean, detail?: string) {
    if (condition) {
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
      passed++;
    } else {
      console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
      failed++;
    }
  }

  const unique = Date.now();
  const phonePrefix = `+1213999${String(unique).slice(-4)}`;
  const insertedPhones: string[] = [];
  const createdCampaignIds: number[] = [];
  let orgId = "";
  let brandId = 0;
  let shortDomainId = 0;
  let destId = 0;

  // contact_id by role label
  const cid: Record<string, string> = {};

  // Resolve current tier of one contact in one campaign via the REAL fragment.
  // Absent from the fragment's output ⇒ COALESCE to 0 (ignored), exactly how
  // callers will read it.
  async function tierFor(campaignId: number, contactId: string): Promise<number> {
    const rows = (await db.execute(drizzleSql`
      SELECT COALESCE((
        SELECT t.tier
        FROM (${campaignTierExpr(campaignId, orgId)}) t
        WHERE t.contact_id = ${contactId}::uuid
      ), 0)::int AS tier
    `)) as unknown as { tier: number }[];
    return Number(rows[0]?.tier ?? -1);
  }

  try {
    // --- Org: reuse any existing organization (FK target only). ---
    const orgRows = (await db.execute(drizzleSql`
      SELECT id::text AS id FROM organizations ORDER BY created_at ASC LIMIT 1
    `)) as unknown as { id: string }[];
    if (!orgRows[0]) {
      throw new Error("No organization exists to attach test fixtures to.");
    }
    orgId = orgRows[0].id;

    // --- Brand + short domain + link destination (FK deps for `links`). ---
    const brandRows = (await db.execute(drizzleSql`
      INSERT INTO brands (org_id, brand_id, name)
      VALUES (${orgId}::uuid, ${`TIER-${unique}`}, ${`Tier Test Brand ${unique}`})
      RETURNING id
    `)) as unknown as { id: number }[];
    brandId = brandRows[0].id;

    const sdRows = (await db.execute(drizzleSql`
      INSERT INTO short_domains (org_id, brand_id, domain)
      VALUES (${orgId}::uuid, ${brandId}::int, ${`tier-${unique}.test`})
      RETURNING id
    `)) as unknown as { id: number }[];
    shortDomainId = sdRows[0].id;

    const destRows = (await db.execute(drizzleSql`
      INSERT INTO link_destinations (org_id, url, url_hash)
      VALUES (${orgId}::uuid, ${"https://example.test/offer"}, ${`hash-${unique}`})
      RETURNING id
    `)) as unknown as { id: number }[];
    destId = destRows[0].id;

    // --- Two campaigns, each with one stage. A = "this campaign", B = "other". ---
    async function seedCampaignStage(suffix: string) {
      const camp = (await db.execute(drizzleSql`
        INSERT INTO campaigns (org_id, slug, name, brand_id)
        VALUES (${orgId}::uuid, ${`tier-${suffix}-${unique}`}, ${`Tier Camp ${suffix}`}, ${brandId}::int)
        RETURNING id
      `)) as unknown as { id: number }[];
      const campaignId = camp[0].id;
      createdCampaignIds.push(campaignId);
      const stage = (await db.execute(drizzleSql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number)
        VALUES (${orgId}::uuid, ${campaignId}::int, 1)
        RETURNING id
      `)) as unknown as { id: number }[];
      return { campaignId, stageId: stage[0].id };
    }
    const campA = await seedCampaignStage("a");
    const campB = await seedCampaignStage("b");

    // --- Contacts (one per behavioral scenario). ---
    const roles = [
      "none", // no activity → 0
      "clicked", // clean click in A → 1
      "clicked_unknown", // 'unknown'-class click in A → 1 (clean)
      "clicked_reached", // clean click + reached in A → 2
      "reached_sale", // reached + sale in A → 3
      "dirty_only", // bot/prefetch/suspect clicks in A → 0
      "click_here_sale_b", // clean click in A + sale in B → 1 here / 3 in B
      "other_campaign", // reached + sale in B only → 0 in A / 3 in B
    ];
    for (const role of roles) {
      const phone = `${phonePrefix}${roles.indexOf(role)}`;
      insertedPhones.push(phone);
      const rows = (await db.execute(drizzleSql`
        INSERT INTO contacts (org_id, phone_number, created_at, updated_at)
        VALUES (${orgId}::uuid, ${phone}, now(), now())
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      cid[role] = rows[0].id;
    }

    // --- Seed helpers. ---
    let codeSeq = 0;
    async function seedClick(
      campaignId: number,
      stageId: number,
      contactId: string,
      classification: string,
    ) {
      codeSeq += 1;
      const linkRows = (await db.execute(drizzleSql`
        INSERT INTO links
          (org_id, code, short_domain_id, destination_id, campaign_id, stage_id,
           contact_id, send_token, campaign_tracking_id, stage_tracking_id)
        VALUES
          (${orgId}::uuid, ${`tt-${unique}-${codeSeq}`}, ${shortDomainId}::int,
           ${destId}::int, ${campaignId}::int, ${stageId}::int, ${contactId}::uuid,
           ${randomUUID()}, ${`ct-${unique}`}, ${`st-${unique}`})
        RETURNING id
      `)) as unknown as { id: number }[];
      await db.execute(drizzleSql`
        INSERT INTO clicks (org_id, link_id, classification)
        VALUES (${orgId}::uuid, ${linkRows[0].id}::bigint, ${classification})
      `);
    }
    async function seedSend(
      campaignId: number,
      stageId: number,
      contactId: string,
      reached: boolean,
      saleStatus: string | null,
    ) {
      await db.execute(drizzleSql`
        INSERT INTO stage_sends
          (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status,
           sale_status, offer_reached_at, offer_reach_event_id)
        VALUES
          (${orgId}::uuid, ${campaignId}::int, ${stageId}::int, ${contactId}::uuid,
           ${"x"}, ${"test body"}, ${"sent"}, ${saleStatus},
           ${reached ? drizzleSql`now()` : drizzleSql`NULL`},
           ${reached ? `evt-${contactId}` : null})
      `);
    }

    // --- Apply signals. ---
    await seedClick(campA.campaignId, campA.stageId, cid.clicked, "human");
    await seedClick(campA.campaignId, campA.stageId, cid.clicked_unknown, "unknown");
    await seedClick(campA.campaignId, campA.stageId, cid.clicked_reached, "human");
    await seedSend(campA.campaignId, campA.stageId, cid.clicked_reached, true, null);
    await seedSend(campA.campaignId, campA.stageId, cid.reached_sale, true, "sale");
    // dirty_only: one of each excluded classification, no clean click → still 0.
    await seedClick(campA.campaignId, campA.stageId, cid.dirty_only, "bot");
    await seedClick(campA.campaignId, campA.stageId, cid.dirty_only, "prefetch");
    await seedClick(campA.campaignId, campA.stageId, cid.dirty_only, "suspect");
    // click here, sale in B.
    await seedClick(campA.campaignId, campA.stageId, cid.click_here_sale_b, "human");
    await seedSend(campB.campaignId, campB.stageId, cid.click_here_sale_b, false, "sale");
    // other_campaign: reached + sale in B only.
    await seedSend(campB.campaignId, campB.stageId, cid.other_campaign, true, "sale");

    // ====================================================================
    // ASSERTIONS — campaign A (this campaign)
    // ====================================================================
    console.log("\nCampaign A (this campaign):");
    check("no activity → 0", (await tierFor(campA.campaignId, cid.none)) === 0);
    check("clean click only → 1", (await tierFor(campA.campaignId, cid.clicked)) === 1);
    check(
      "'unknown'-class click counts as clean → 1",
      (await tierFor(campA.campaignId, cid.clicked_unknown)) === 1,
    );
    check(
      "clicked + reached → 2 (high-water, not 1)",
      (await tierFor(campA.campaignId, cid.clicked_reached)) === 2,
    );
    check(
      "reached + sale → 3 (high-water)",
      (await tierFor(campA.campaignId, cid.reached_sale)) === 3,
    );
    check(
      "bot/prefetch/suspect click only → 0 (not counted as clicked)",
      (await tierFor(campA.campaignId, cid.dirty_only)) === 0,
    );
    check(
      "activity in a DIFFERENT campaign → 0 here (scoping)",
      (await tierFor(campA.campaignId, cid.other_campaign)) === 0,
    );
    check(
      "clicked here + sale elsewhere → 1 here, not 3",
      (await tierFor(campA.campaignId, cid.click_here_sale_b)) === 1,
    );

    // ====================================================================
    // ASSERTIONS — campaign B (the OTHER campaign) — confirms scoping both ways
    // ====================================================================
    console.log("\nCampaign B (the other campaign):");
    check(
      "sale-in-B contact → 3 in B (scoping reads the other side)",
      (await tierFor(campB.campaignId, cid.click_here_sale_b)) === 3,
    );
    check(
      "reached+sale-in-B contact → 3 in B",
      (await tierFor(campB.campaignId, cid.other_campaign)) === 3,
    );
    check(
      "A-only clicker → 0 in B (scoping)",
      (await tierFor(campB.campaignId, cid.clicked)) === 0,
    );
  } finally {
    console.log("\nCleanup");
    try {
      // Deleting campaigns cascades campaign_stages, stage_sends, links (and
      // clicks via links) — clearing the RESTRICT refs to short_domain/dest.
      for (const c of createdCampaignIds) {
        await db.execute(drizzleSql`DELETE FROM campaigns WHERE id = ${c}`);
      }
      if (destId) {
        await db.execute(drizzleSql`DELETE FROM link_destinations WHERE id = ${destId}`);
      }
      if (shortDomainId) {
        await db.execute(drizzleSql`DELETE FROM short_domains WHERE id = ${shortDomainId}`);
      }
      if (insertedPhones.length > 0) {
        const phoneArray = drizzleSql`ARRAY[${drizzleSql.join(
          insertedPhones.map((p) => drizzleSql`${p}`),
          drizzleSql`, `,
        )}]::text[]`;
        await db.execute(drizzleSql`
          DELETE FROM contacts
          WHERE org_id = ${orgId}::uuid
            AND phone_number = ANY(${phoneArray})
        `);
      }
      if (brandId) {
        await db.execute(drizzleSql`DELETE FROM brands WHERE id = ${brandId}`);
      }
      console.log("  cleanup complete");
    } finally {
      await pg.end({ timeout: 5 });
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
