import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { contacts, segments } from "../db/schema";

// Offer-reach rule test suite (segment engagement Level 2).
//
// Two headline guarantees:
//   1. EMPTY-DATA CASE — with zero offer reaches, a reached_offer rule resolves
//      to manual membership only (an empty preview = "no one reached offer yet",
//      not a bug).
//   2. "Reached offer but did NOT buy" = reached_offer (is) AND made_purchase
//      (is_not) returns exactly the reacher who didn't buy.
// Plus brand/offer scoping mirrors the clicker/purchase rules.

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const appUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
  const dbUrl = process.env.DATABASE_URL!;
  const testEmail = process.env.TEST_USER_EMAIL;
  const testPassword = process.env.TEST_USER_PASSWORD;
  if (!testEmail || !testPassword) {
    console.error("Set TEST_USER_EMAIL/TEST_USER_PASSWORD in .env.local.");
    process.exit(1);
  }

  const cookieJar = new Map<string, string>();
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () =>
        Array.from(cookieJar.entries()).map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) cookieJar.set(name, value);
      },
    },
  });

  console.log(`Signing in as ${testEmail}…`);
  const { error: signInErr } = await supabase.auth.signInWithPassword({
    email: testEmail,
    password: testPassword,
  });
  if (signInErr) {
    console.error(`Sign-in failed: ${signInErr.message}`);
    process.exit(1);
  }

  function cookieHeader() {
    return Array.from(cookieJar.entries())
      .map(([n, v]) => `${n}=${v}`)
      .join("; ");
  }
  async function apiFetch(path: string, init?: RequestInit) {
    return fetch(`${appUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
        Cookie: cookieHeader(),
      },
    });
  }

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

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);
  const unique = Date.now();
  const base = (Number(String(unique).slice(-6)) % 9_000) + 1_000;

  const manualPhones = [0, 1, 2, 3, 4].map(
    (i) => `+1213720${String(base + i).padStart(4, "0")}`,
  );
  const externalPhones = [0, 1, 2, 3, 4].map(
    (i) => `+1213820${String(base + i).padStart(4, "0")}`,
  );

  const createdSegmentIds: number[] = [];
  const createdBrandIds: number[] = [];
  const createdOfferIds: number[] = [];
  const createdNetworkIds: number[] = [];
  const createdCampaignIds: number[] = [];
  const insertedPhones: string[] = [...manualPhones, ...externalPhones];
  let orgId = "";
  let brandAId = 0;
  let brandBId = 0;
  let offerAId = 0;
  let offerBId = 0;

  async function previewCount(segmentId: number): Promise<number> {
    const r = await apiFetch(`/api/segments/${segmentId}/rules/preview`, {
      method: "POST",
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`preview ${r.status}: ${text}`);
    return (JSON.parse(text) as { count: number }).count;
  }
  async function createRule(
    segmentId: number,
    ruleType: string,
    value: unknown,
    operator: "is" | "is_not" = "is",
    combinator: "and" | "or" = "and",
  ): Promise<number> {
    const r = await apiFetch(`/api/segments/${segmentId}/rules`, {
      method: "POST",
      body: JSON.stringify({
        rule_type: ruleType,
        operator,
        value,
        is_active: true,
        combinator,
      }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`createRule ${ruleType} ${r.status}: ${text}`);
    return (JSON.parse(text) as { id: number }).id;
  }
  async function deleteRule(segmentId: number, ruleId: number) {
    await apiFetch(`/api/segments/${segmentId}/rules/${ruleId}`, {
      method: "DELETE",
    });
  }

  try {
    // --- Registry: two brands, two offers, a network. ---
    const brandAR = await apiFetch("/api/brands", {
      method: "POST",
      body: JSON.stringify({ name: `OR Brand A ${unique}`, brand_id: `OR-A-${unique}` }),
    });
    if (brandAR.status !== 201) {
      console.error("brand A create failed", await brandAR.text());
      process.exit(1);
    }
    const brandA = (await brandAR.json()) as { id: number; org_id: string };
    orgId = brandA.org_id;
    brandAId = brandA.id;
    createdBrandIds.push(brandA.id);

    const brandBR = await apiFetch("/api/brands", {
      method: "POST",
      body: JSON.stringify({ name: `OR Brand B ${unique}`, brand_id: `OR-B-${unique}` }),
    });
    brandBId = ((await brandBR.json()) as { id: number }).id;
    createdBrandIds.push(brandBId);

    const netR = await apiFetch("/api/networks", {
      method: "POST",
      body: JSON.stringify({ name: `OR Network ${unique}`, network_id: `OR-N-${unique}` }),
    });
    const netId = ((await netR.json()) as { id: number }).id;
    createdNetworkIds.push(netId);

    const offerAR = await apiFetch("/api/offers", {
      method: "POST",
      body: JSON.stringify({
        name: `OR Offer A ${unique}`, offer_id: `OR-OF-A-${unique}`,
        brand_id: brandAId, network_id: netId, payout_model: "cpa", payout_cpa: 1,
      }),
    });
    if (offerAR.status !== 201) {
      console.error("offer A create failed", await offerAR.text());
      process.exit(1);
    }
    offerAId = ((await offerAR.json()) as { id: number }).id;
    createdOfferIds.push(offerAId);

    const offerBR = await apiFetch("/api/offers", {
      method: "POST",
      body: JSON.stringify({
        name: `OR Offer B ${unique}`, offer_id: `OR-OF-B-${unique}`,
        brand_id: brandBId, network_id: netId, payout_model: "cpa", payout_cpa: 1,
      }),
    });
    offerBId = ((await offerBR.json()) as { id: number }).id;
    createdOfferIds.push(offerBId);

    // --- SEG_M: 5 manual contacts (for empty-data tests). ---
    const segMR = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({ name: `OR Seg M ${unique}`, segment_id: `OR-SEGM-${unique}` }),
    });
    check("SEG_M creation returns 201", segMR.status === 201);
    const segM = (await segMR.json()) as { id: number };
    createdSegmentIds.push(segM.id);
    const upR = await apiFetch(`/api/segments/${segM.id}/contacts/upload`, {
      method: "POST",
      body: JSON.stringify({ phones: manualPhones.join("\n") }),
    });
    check("manual upload returns 201", upR.status === 201);

    // --- SEG_E: ZERO manual members (audience = rule matches only, so
    //     "the non-buyer only" is cleanly assertable). ---
    const segER = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({ name: `OR Seg E ${unique}`, segment_id: `OR-SEGE-${unique}` }),
    });
    const segE = (await segER.json()) as { id: number };
    createdSegmentIds.push(segE.id);

    // External contacts (org members, not in either segment).
    for (const p of externalPhones) {
      await db.execute(drizzleSql`
        INSERT INTO contacts (org_id, phone_number, created_at, updated_at)
        VALUES (${orgId}::uuid, ${p}, now(), now())
        ON CONFLICT DO NOTHING
      `);
    }
    const allRows = await db
      .select({ id: contacts.id, phone_number: contacts.phone_number })
      .from(contacts)
      .where(inArray(contacts.phone_number, [...manualPhones, ...externalPhones]));
    const idByPhone = new Map<string, string>();
    for (const r of allRows) idByPhone.set(r.phone_number, r.id);
    if (idByPhone.size !== manualPhones.length + externalPhones.length) {
      throw new Error(`expected ${manualPhones.length + externalPhones.length} contacts, found ${idByPhone.size}.`);
    }

    // ====================================================================
    // PHASE 1 — EMPTY DATA. No offer reaches yet (column is brand-new).
    // ====================================================================
    console.log("\n[E1] reached_offer (any) with ZERO reaches → manual only (5)");
    const e1 = await createRule(segM.id, "reached_offer", null);
    const e1c = await previewCount(segM.id);
    check("[E1] no one reached offer yet: count = manual = 5 (empty preview is not a bug)", e1c === 5, `got ${e1c}`);
    await deleteRule(segM.id, e1);

    console.log("\n[E2] reached_offer_for_brand (A) with ZERO reaches → 5");
    const e2 = await createRule(segM.id, "reached_offer_for_brand", brandAId);
    const e2c = await previewCount(segM.id);
    check("[E2] count = manual = 5", e2c === 5, `got ${e2c}`);
    await deleteRule(segM.id, e2);

    console.log("\n[E3] reached_offer_for_offer (A) with ZERO reaches → 5");
    const e3 = await createRule(segM.id, "reached_offer_for_offer", offerAId);
    const e3c = await previewCount(segM.id);
    check("[E3] count = manual = 5", e3c === 5, `got ${e3c}`);
    await deleteRule(segM.id, e3);

    // ====================================================================
    // PHASE 2 — SEED. Campaign A (brand A / offer A) + Campaign B.
    //   Campaign A: ext0 reached+bought, ext1 reached+NObuy, ext2 NOreach+bought,
    //               ext3 NOreach+NObuy
    //   Campaign B: ext4 reached+bought  (brand/offer scoping)
    // ====================================================================
    async function seedCampaignStage(brandId: number, offerId: number, suffix: string) {
      const camp = (await db.execute(drizzleSql`
        INSERT INTO campaigns (org_id, slug, name, brand_id, offer_id)
        VALUES (${orgId}::uuid, ${`or-${suffix}-${unique}`}, ${`OR Camp ${suffix}`}, ${brandId}::int, ${offerId}::int)
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
    async function seedSend(
      campaignId: number, stageId: number, phone: string,
      reached: boolean, saleStatus: string | null,
    ) {
      await db.execute(drizzleSql`
        INSERT INTO stage_sends
          (org_id, campaign_id, stage_id, contact_id, phone, rendered_text,
           status, sale_status, offer_reached_at, offer_reach_event_id)
        VALUES
          (${orgId}::uuid, ${campaignId}::int, ${stageId}::int,
           ${idByPhone.get(phone)!}::uuid, ${phone}, 'test body', 'sent',
           ${saleStatus},
           ${reached ? drizzleSql`now()` : drizzleSql`NULL`},
           ${reached ? `evt-${phone}` : null})
      `);
    }

    const campA = await seedCampaignStage(brandAId, offerAId, "a");
    await seedSend(campA.campaignId, campA.stageId, externalPhones[0], true, "sale");
    await seedSend(campA.campaignId, campA.stageId, externalPhones[1], true, null);
    await seedSend(campA.campaignId, campA.stageId, externalPhones[2], false, "sale");
    await seedSend(campA.campaignId, campA.stageId, externalPhones[3], false, null);

    const campB = await seedCampaignStage(brandBId, offerBId, "b");
    await seedSend(campB.campaignId, campB.stageId, externalPhones[4], true, "sale");

    // SEG_E has zero manual → audience = rule matches only.
    console.log("\n[P1] reached_offer (any) → {ext0,ext1,ext4} = 3");
    const p1 = await createRule(segE.id, "reached_offer", null);
    const p1c = await previewCount(segE.id);
    check("[P1] count = 3", p1c === 3, `got ${p1c}`);
    await deleteRule(segE.id, p1);

    console.log("\n[P2] made_purchase (any) → {ext0,ext2,ext4} = 3");
    const p2 = await createRule(segE.id, "made_purchase", null);
    const p2c = await previewCount(segE.id);
    check("[P2] count = 3", p2c === 3, `got ${p2c}`);
    await deleteRule(segE.id, p2);

    // ---- HEADLINE: reached offer but did NOT buy = the non-buyer only ----
    console.log("\n[H] reached_offer (is) AND made_purchase (is_not) → {ext1} only = 1");
    const hReached = await createRule(segE.id, "reached_offer", null, "is", "and");
    const hNotBought = await createRule(segE.id, "made_purchase", null, "is_not", "and");
    const hc = await previewCount(segE.id);
    // reached {ext0,ext1,ext4} EXCEPT bought {ext0,ext2,ext4} = {ext1}. If a buyer
    // (ext0/ext4) leaked, count would be >1; if a non-reacher leaked, it'd appear too.
    check("[H] 'reached but did NOT buy' = exactly the one non-buyer (ext1) = 1", hc === 1, `got ${hc}`);
    await deleteRule(segE.id, hReached);
    await deleteRule(segE.id, hNotBought);

    // ---- Brand/offer scoping ----
    console.log("\n[S1] reached_offer_for_brand (A) → {ext0,ext1} = 2");
    const s1 = await createRule(segE.id, "reached_offer_for_brand", brandAId);
    check("[S1] count = 2", (await previewCount(segE.id)) === 2);
    await deleteRule(segE.id, s1);

    console.log("\n[S2] reached_offer_for_brand (B) → {ext4} = 1 (scoping)");
    const s2 = await createRule(segE.id, "reached_offer_for_brand", brandBId);
    check("[S2] count = 1", (await previewCount(segE.id)) === 1);
    await deleteRule(segE.id, s2);

    console.log("\n[S3] reached_offer_for_offer (A) → {ext0,ext1} = 2");
    const s3 = await createRule(segE.id, "reached_offer_for_offer", offerAId);
    check("[S3] count = 2", (await previewCount(segE.id)) === 2);
    await deleteRule(segE.id, s3);

    console.log("\n[S4] reached_offer_for_offer (B) → {ext4} = 1 (scoping)");
    const s4 = await createRule(segE.id, "reached_offer_for_offer", offerBId);
    check("[S4] count = 1", (await previewCount(segE.id)) === 1);
    await deleteRule(segE.id, s4);
  } finally {
    console.log("\nCleanup");
    try {
      for (const cid of createdCampaignIds) {
        await db.execute(drizzleSql`DELETE FROM campaigns WHERE id = ${cid}`);
      }
      for (const sid of createdSegmentIds) {
        await db.delete(segments).where(eq(segments.id, sid));
      }
      if (insertedPhones.length > 0) {
        await db.delete(contacts).where(inArray(contacts.phone_number, insertedPhones));
      }
      for (const oid of createdOfferIds) {
        await db.execute(drizzleSql`DELETE FROM offers WHERE id = ${oid}`);
      }
      for (const nid of createdNetworkIds) {
        await db.execute(drizzleSql`DELETE FROM affiliate_networks WHERE id = ${nid}`);
      }
      for (const bid of createdBrandIds) {
        await db.execute(drizzleSql`DELETE FROM brands WHERE id = ${bid}`);
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
