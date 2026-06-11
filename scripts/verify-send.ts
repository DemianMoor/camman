import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { kickoffStageSend } from "@/lib/sends/kickoff";
import { enumerateStageRecipients } from "@/lib/sends/recipients";
import { buildStageSms } from "@/lib/sends/stage-sms";
import { buildSendUrl } from "@/lib/sends/texthub";

// Verifies the send pipeline's non-sending pieces WITHOUT persisting anything
// (rolled-back tx) and WITHOUT hitting TextHub. Self-contained fixtures so it
// doesn't depend on dev-data shape (beyond org/brand/offer/creative/contacts
// existing). Covers: composer parity, TextHub URL contract (text not
// long_url/group), recipient enumeration, manual + tracked kickoff (mint one
// link per recipient, freeze rendered_text), and the already_pending +
// no_credentials refusals.
//
// Run: npx tsx scripts/verify-send.ts

class Rollback extends Error {}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  // ---- Pure: composer parity with the stage-form preview formula.
  console.log("Composer:");
  assert(
    buildStageSms({ brandName: "Acme", creativeText: "Hi", linkUrl: "https://x/y", stopText: "Stop to END" }) ===
      "Acme: Hi\nhttps://x/y\nStop to END",
    "with link → brand: text \\n link \\n stop",
  );
  assert(
    buildStageSms({ brandName: "Acme", creativeText: "Hi", linkUrl: "", stopText: "Stop to END" }) ===
      "Acme: Hi\nStop to END",
    "no link → brand: text \\n stop",
  );
  assert(buildStageSms({ brandName: "Acme", creativeText: null, stopText: "x" }) === "", "no creative → empty");

  // ---- Pure: TextHub URL contract.
  console.log("TextHub URL:");
  const u = buildSendUrl({ apiKey: "K", text: "see https://vs.example/r/abc", number: "+15551230000" });
  assert(u.includes("api_key=K"), "api_key present");
  assert(u.includes("number=%2B15551230000") || u.includes("number=+15551230000"), "number present");
  assert(u.includes("text="), "text present");
  assert(!u.includes("long_url"), "long_url NEVER set (keeps our URL un-rewritten)");
  assert(!u.includes("group="), "group NEVER set (single-recipient)");

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);
  let failed = false;

  try {
    await db.transaction(async (tx) => {
      const pick = async (q: ReturnType<typeof sql>) =>
        (await tx.execute(q)) as unknown as Record<string, unknown>[];

      const org = await pick(sql`SELECT id FROM organizations LIMIT 1`);
      if (!org[0]) { console.log("SKIP: no organizations."); throw new Rollback(); }
      const orgId = org[0].id as string;

      // Create a throwaway brand (rolled back) so the fixture owns a fresh
      // short domain — the picked org's real brand may already have one (with
      // links referencing it, so it can't be swapped).
      const sfx = Date.now().toString().slice(-9);
      const brand = await pick(sql`
        INSERT INTO brands (org_id, brand_id, name, status)
        VALUES (${orgId}, ${"vs-brand-" + sfx}, ${"VS Brand"}, 'active')
        RETURNING id, name
      `);
      const offer = await pick(sql`SELECT id FROM offers WHERE org_id = ${orgId} LIMIT 1`);
      const creative = await pick(sql`SELECT id, text FROM creatives WHERE org_id = ${orgId} LIMIT 1`);
      const contacts = await pick(sql`SELECT id, phone_number FROM contacts WHERE org_id = ${orgId} LIMIT 2`);
      if (!brand[0] || !offer[0] || !creative[0] || contacts.length < 2) {
        console.log("SKIP: need an org with ≥1 brand, offer, creative and ≥2 contacts.");
        throw new Rollback();
      }
      const brandId = Number(brand[0].id);
      const brandName = String(brand[0].name);
      const offerId = Number(offer[0].id);
      const creativeId = Number(creative[0].id);
      const creativeText = String(creative[0].text);

      // Fixtures (rolled back): campaign + provider + stage + pooled contacts.
      const camp = await pick(sql`
        INSERT INTO campaigns (org_id, slug, brand_id, offer_id, tracking_id, link_mode, status)
        VALUES (${orgId}, ${"vs-send-test"}, ${brandId}, ${offerId}, ${"vs_camp"}, 'manual', 'active')
        RETURNING id
      `);
      const campaignId = Number(camp[0].id);

      const prov = await pick(sql`
        INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send, status)
        VALUES (${"vs-prov-test"}, ${orgId}, ${"VS Provider"}, true, 'active')
        RETURNING id
      `);
      const providerId = Number(prov[0].id);

      const stg = await pick(sql`
        INSERT INTO campaign_stages
          (org_id, campaign_id, stage_number, creative_id, tracking_id, sms_provider_id,
           sales_page_label, short_url, stop_text)
        VALUES
          (${orgId}, ${campaignId}, 1, ${creativeId}, ${"vs_camp_s1"}, ${providerId},
           ${"vs"}, ${"https://sho.rt/manual"}, ${"Stop to END"})
        RETURNING id
      `);
      const stageId = Number(stg[0].id);

      for (const c of contacts) {
        await tx.execute(sql`
          INSERT INTO campaign_audience_pool
            (campaign_id, contact_id, org_id, was_no_status_at_snapshot)
          VALUES (${campaignId}, ${c.id as string}, ${orgId}, true)
        `);
      }

      // ---- Enumeration
      console.log("Enumeration:");
      const recips = await enumerateStageRecipients(tx, {
        campaignId, orgId,
        filters: { includeNoStatus: true, includeClickers: false, excludeClickers: false, splitIndex: null, splitTotal: null },
      });
      assert(recips.length === 2, "enumerates the 2 pooled contacts");

      // ---- Manual kickoff
      console.log("Manual kickoff:");
      const m = await kickoffStageSend(tx, { orgId, campaignId, stageId });
      assert(m.ok && m.mode === "manual" && m.materialized === 2, "materialized 2 manual sends");
      const mrow = (await pick(sql`SELECT link_id, rendered_text FROM stage_sends WHERE stage_id = ${stageId} LIMIT 1`))[0];
      assert(mrow.link_id === null, "manual row has no link_id");
      assert(
        mrow.rendered_text === buildStageSms({ brandName, creativeText, linkUrl: "https://sho.rt/manual", stopText: "Stop to END" }),
        "manual rendered_text matches composer (frozen pasted short_url)",
      );

      // ---- already_pending guard
      const again = await kickoffStageSend(tx, { orgId, campaignId, stageId });
      assert(!again.ok && again.reason === "already_pending", "second kickoff refused: already_pending");

      // Reset for tracked.
      await tx.execute(sql`DELETE FROM stage_sends WHERE stage_id = ${stageId}`);
      await tx.execute(sql`UPDATE campaigns SET link_mode = 'tracked' WHERE id = ${campaignId}`);
      await tx.execute(sql`INSERT INTO short_domains (org_id, brand_id, domain, status) VALUES (${orgId}, ${brandId}, ${"vs.example"}, 'active')`);
      // Give the offer a sales page so the tracked link has a destination
      // (kickoff reads this within the same tx via the dbc-aware loader).
      await tx.execute(sql`UPDATE offers SET sales_pages = ${JSON.stringify([{ label: "vs", url: "https://example.com/lp" }])}::jsonb, postfix = ${"sub_id"} WHERE id = ${offerId}`);

      // ---- Tracked refusal: no credentials yet
      console.log("Tracked guard:");
      const noCreds = await kickoffStageSend(tx, { orgId, campaignId, stageId });
      assert(!noCreds.ok && noCreds.reason === "no_credentials", "tracked refused without provider credentials");

      // Add credentials → tracked happy path
      await tx.execute(sql`INSERT INTO provider_credentials (org_id, provider_id, api_key) VALUES (${orgId}, ${providerId}, ${"test-key"})`);
      console.log("Tracked kickoff:");
      const t = await kickoffStageSend(tx, { orgId, campaignId, stageId });
      assert(t.ok && t.mode === "tracked" && t.materialized === 2, "materialized 2 tracked sends");

      const trows = (await pick(sql`SELECT link_id, rendered_text FROM stage_sends WHERE stage_id = ${stageId}`));
      assert(trows.every((r) => r.link_id !== null), "every tracked row has a link_id");
      assert(trows.every((r) => String(r.rendered_text).includes("https://vs.example/r/")), "rendered_text carries the minted short link");
      const codes = (await pick(sql`SELECT code FROM links WHERE stage_id = ${stageId}`)).map((r) => r.code);
      assert(codes.length === 2 && new Set(codes).size === 2, "two distinct minted codes (one per recipient)");

      console.log("\nAll assertions passed. Rolling back (no data persisted).");
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) { console.error("\nVerification FAILED:", err); failed = true; }
  } finally {
    await pg.end({ timeout: 5 });
  }

  if (failed) process.exit(1);
  console.log("verify-send OK.");
}

main().catch((err) => { console.error("verify-send crashed:", err); process.exit(1); });
