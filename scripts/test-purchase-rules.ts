import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { contacts, segments } from "../db/schema";

// Purchase-rule test suite (segment engagement Level 3).
//
// Exercises the three made_purchase_* rule types against directly-seeded
// stage_sends rows. Two things this suite is specifically here to prove:
//   1. EMPTY-DATA CASE — with zero sales, a made_purchase rule resolves to
//      manual membership only (preview = manual_count). An empty preview is
//      "no buyers yet", NOT a bug.
//   2. Only sale_status='sale' counts — 'lead', 'rejected', and NULL never do.
// Plus brand/offer scoping mirrors the clicker rules.

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
        Array.from(cookieJar.entries()).map(([name, value]) => ({
          name,
          value,
        })),
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
    (i) => `+1213710${String(base + i).padStart(4, "0")}`,
  );
  const externalPhones = [0, 1, 2, 3, 4, 5].map(
    (i) => `+1213810${String(base + i).padStart(4, "0")}`,
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

  // Helpers shared across phases.
  async function previewCount(segmentId: number): Promise<number> {
    const r = await apiFetch(`/api/segments/${segmentId}/rules/preview`, {
      method: "POST",
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`preview ${r.status}: ${text}`);
    const body = JSON.parse(text) as { count: number };
    return body.count;
  }
  async function createRule(
    segmentId: number,
    ruleType: string,
    value: unknown,
  ): Promise<number> {
    const r = await apiFetch(`/api/segments/${segmentId}/rules`, {
      method: "POST",
      body: JSON.stringify({
        rule_type: ruleType,
        operator: "is",
        value,
        is_active: true,
      }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`createRule ${ruleType} ${r.status}: ${text}`);
    const body = JSON.parse(text) as { id: number };
    return body.id;
  }
  async function deleteRule(segmentId: number, ruleId: number) {
    await apiFetch(`/api/segments/${segmentId}/rules/${ruleId}`, {
      method: "DELETE",
    });
  }
  async function patchOperator(
    segmentId: number,
    ruleId: number,
    operator: "is" | "is_not",
  ) {
    await apiFetch(`/api/segments/${segmentId}/rules/${ruleId}`, {
      method: "PATCH",
      body: JSON.stringify({ operator }),
    });
  }

  try {
    // --- Registry fixtures: two brands, two offers, a network. ---
    const brandAR = await apiFetch("/api/brands", {
      method: "POST",
      body: JSON.stringify({
        name: `Buy Brand A ${unique}`,
        brand_id: `BUY-A-${unique}`,
      }),
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
      body: JSON.stringify({
        name: `Buy Brand B ${unique}`,
        brand_id: `BUY-B-${unique}`,
      }),
    });
    brandBId = ((await brandBR.json()) as { id: number }).id;
    createdBrandIds.push(brandBId);

    const netR = await apiFetch("/api/networks", {
      method: "POST",
      body: JSON.stringify({
        name: `Buy Network ${unique}`,
        network_id: `BUY-N-${unique}`,
      }),
    });
    const netId = ((await netR.json()) as { id: number }).id;
    createdNetworkIds.push(netId);

    const offerAR = await apiFetch("/api/offers", {
      method: "POST",
      body: JSON.stringify({
        name: `Buy Offer A ${unique}`,
        offer_id: `BUY-OF-A-${unique}`,
        brand_id: brandAId,
        network_id: netId,
        payout_model: "cpa",
        payout_cpa: 1,
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
        name: `Buy Offer B ${unique}`,
        offer_id: `BUY-OF-B-${unique}`,
        brand_id: brandBId,
        network_id: netId,
        payout_model: "cpa",
        payout_cpa: 1,
      }),
    });
    offerBId = ((await offerBR.json()) as { id: number }).id;
    createdOfferIds.push(offerBId);

    // --- Segment with 5 manual contacts + 6 external (org-only) contacts. ---
    const segR = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({
        name: `Buy Seg ${unique}`,
        segment_id: `BUY-SEG-${unique}`,
      }),
    });
    check("segment creation returns 201", segR.status === 201);
    const seg = (await segR.json()) as { id: number };
    createdSegmentIds.push(seg.id);

    const upR = await apiFetch(`/api/segments/${seg.id}/contacts/upload`, {
      method: "POST",
      body: JSON.stringify({ phones: manualPhones.join("\n") }),
    });
    check("manual upload returns 201", upR.status === 201);
    // External contacts: org members not in the segment. Inserted directly
    // (the /api/contacts/upload endpoint now requires a contact group; we
    // don't need one here, so bypass it like the backdated-contact fixtures
    // in test-segment-rules-api.ts do).
    for (const p of externalPhones) {
      await db.execute(drizzleSql`
        INSERT INTO contacts (org_id, phone_number, created_at, updated_at)
        VALUES (${orgId}::uuid, ${p}, now(), now())
        ON CONFLICT DO NOTHING
      `);
    }
    check("external contacts inserted", true);

    const allRows = await db
      .select({ id: contacts.id, phone_number: contacts.phone_number })
      .from(contacts)
      .where(
        inArray(contacts.phone_number, [...manualPhones, ...externalPhones]),
      );
    const idByPhone = new Map<string, string>();
    for (const r of allRows) idByPhone.set(r.phone_number, r.id);
    if (idByPhone.size !== manualPhones.length + externalPhones.length) {
      throw new Error(
        `expected ${manualPhones.length + externalPhones.length} contacts, found ${idByPhone.size}.`,
      );
    }

    // ====================================================================
    // PHASE 1 — EMPTY DATA. No stage_sends rows exist yet, so no buyers.
    // Every made_purchase variant must resolve to manual membership only.
    // ====================================================================
    console.log("\n[E1] made_purchase (any) with ZERO sales → manual only (5)");
    const e1 = await createRule(seg.id, "made_purchase", null);
    const e1Count = await previewCount(seg.id);
    check(
      "[E1] no buyers yet: count = manual = 5 (empty preview is not a bug)",
      e1Count === 5,
      `got ${e1Count}`,
    );
    await deleteRule(seg.id, e1);

    console.log("\n[E2] made_purchase_for_brand (A) with ZERO sales → 5");
    const e2 = await createRule(seg.id, "made_purchase_for_brand", brandAId);
    const e2Count = await previewCount(seg.id);
    check("[E2] count = manual = 5", e2Count === 5, `got ${e2Count}`);
    await deleteRule(seg.id, e2);

    console.log("\n[E3] made_purchase_for_offer (A) with ZERO sales → 5");
    const e3 = await createRule(seg.id, "made_purchase_for_offer", offerAId);
    const e3Count = await previewCount(seg.id);
    check("[E3] count = manual = 5", e3Count === 5, `got ${e3Count}`);
    await deleteRule(seg.id, e3);

    // ====================================================================
    // PHASE 2 — SEED SALES. Two campaigns (brand A / offer A, brand B /
    // offer B), one stage each, and stage_sends rows with mixed statuses:
    //   Brand A / Offer A:
    //     ext0 = 'sale', ext1 = 'sale', man0 = 'sale'  (3 buyers, 1 manual)
    //     ext2 = 'lead', ext3 = 'rejected', ext4 = NULL (must NOT count)
    //   Brand B / Offer B:
    //     ext5 = 'sale'  (scoping check)
    // ====================================================================
    async function seedCampaignStage(
      brandId: number,
      offerId: number,
      slugSuffix: string,
    ): Promise<{ campaignId: number; stageId: number }> {
      const campRows = (await db.execute(drizzleSql`
        INSERT INTO campaigns (org_id, slug, name, brand_id, offer_id)
        VALUES (${orgId}::uuid, ${`buy-${slugSuffix}-${unique}`},
                ${`Buy Camp ${slugSuffix}`}, ${brandId}::int, ${offerId}::int)
        RETURNING id
      `)) as unknown as { id: number }[];
      const campaignId = campRows[0].id;
      createdCampaignIds.push(campaignId);
      const stageRows = (await db.execute(drizzleSql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number)
        VALUES (${orgId}::uuid, ${campaignId}::int, 1)
        RETURNING id
      `)) as unknown as { id: number }[];
      return { campaignId, stageId: stageRows[0].id };
    }

    async function seedSend(
      campaignId: number,
      stageId: number,
      phone: string,
      saleStatus: string | null,
    ) {
      await db.execute(drizzleSql`
        INSERT INTO stage_sends
          (org_id, campaign_id, stage_id, contact_id, phone,
           rendered_text, status, sale_status)
        VALUES
          (${orgId}::uuid, ${campaignId}::int, ${stageId}::int,
           ${idByPhone.get(phone)!}::uuid, ${phone}, ${"test body"}, 'sent',
           ${saleStatus})
      `);
    }

    const campA = await seedCampaignStage(brandAId, offerAId, "a");
    await seedSend(campA.campaignId, campA.stageId, externalPhones[0], "sale");
    await seedSend(campA.campaignId, campA.stageId, externalPhones[1], "sale");
    await seedSend(campA.campaignId, campA.stageId, manualPhones[0], "sale");
    await seedSend(campA.campaignId, campA.stageId, externalPhones[2], "lead");
    await seedSend(
      campA.campaignId,
      campA.stageId,
      externalPhones[3],
      "rejected",
    );
    await seedSend(campA.campaignId, campA.stageId, externalPhones[4], null);

    const campB = await seedCampaignStage(brandBId, offerBId, "b");
    await seedSend(campB.campaignId, campB.stageId, externalPhones[5], "sale");

    // Buyers across the org: ext0, ext1, man0 (brand A) + ext5 (brand B) = 4
    // distinct, 1 of which (man0) is already a manual member.
    console.log(
      "\n[P1] made_purchase (any): manual(5) ∪ buyers{ext0,ext1,man0,ext5} = 8",
    );
    const p1 = await createRule(seg.id, "made_purchase", null);
    const p1Count = await previewCount(seg.id);
    // If 'lead'/'rejected'/NULL leaked in, ext2/ext3/ext4 would push this to 11.
    check(
      "[P1] count = 8 (only 'sale' counts — lead/rejected/NULL excluded)",
      p1Count === 8,
      `got ${p1Count}`,
    );

    // Inversion invariant for is_not: |is| + |is_not| = totalOrg + manual.
    const totalOrgRow = (await db.execute(drizzleSql`
      SELECT count(*)::int AS n FROM contacts WHERE org_id = ${orgId}::uuid
    `)) as unknown as { n: number }[];
    const expectedSum = (totalOrgRow[0]?.n ?? 0) + 5;
    await patchOperator(seg.id, p1, "is_not");
    const p1NotCount = await previewCount(seg.id);
    check(
      "[P1] is_not (did NOT purchase): inversion invariant holds",
      p1Count + p1NotCount === expectedSum,
      `got ${p1Count}+${p1NotCount}=${p1Count + p1NotCount}, expected ${expectedSum}`,
    );
    await deleteRule(seg.id, p1);

    console.log(
      "\n[P2] made_purchase_for_brand (A): manual(5) ∪ {ext0,ext1,man0} = 7",
    );
    const p2 = await createRule(seg.id, "made_purchase_for_brand", brandAId);
    const p2Count = await previewCount(seg.id);
    check("[P2] count = 7", p2Count === 7, `got ${p2Count}`);
    await deleteRule(seg.id, p2);

    console.log(
      "\n[P3] made_purchase_for_brand (B): manual(5) ∪ {ext5} = 6 (scoping)",
    );
    const p3 = await createRule(seg.id, "made_purchase_for_brand", brandBId);
    const p3Count = await previewCount(seg.id);
    check("[P3] count = 6", p3Count === 6, `got ${p3Count}`);
    await deleteRule(seg.id, p3);

    console.log(
      "\n[P4] made_purchase_for_offer (A): manual(5) ∪ {ext0,ext1,man0} = 7",
    );
    const p4 = await createRule(seg.id, "made_purchase_for_offer", offerAId);
    const p4Count = await previewCount(seg.id);
    check("[P4] count = 7", p4Count === 7, `got ${p4Count}`);
    await deleteRule(seg.id, p4);

    console.log(
      "\n[P5] made_purchase_for_offer (B): manual(5) ∪ {ext5} = 6 (scoping)",
    );
    const p5 = await createRule(seg.id, "made_purchase_for_offer", offerBId);
    const p5Count = await previewCount(seg.id);
    check("[P5] count = 6", p5Count === 6, `got ${p5Count}`);
    await deleteRule(seg.id, p5);
  } finally {
    console.log("\nCleanup");
    try {
      // Campaigns cascade to stages and stage_sends.
      for (const cid of createdCampaignIds) {
        await db.execute(drizzleSql`DELETE FROM campaigns WHERE id = ${cid}`);
      }
      for (const sid of createdSegmentIds) {
        await db.delete(segments).where(eq(segments.id, sid));
      }
      if (insertedPhones.length > 0) {
        await db
          .delete(contacts)
          .where(inArray(contacts.phone_number, insertedPhones));
      }
      for (const oid of createdOfferIds) {
        await db.execute(drizzleSql`DELETE FROM offers WHERE id = ${oid}`);
      }
      for (const nid of createdNetworkIds) {
        await db.execute(
          drizzleSql`DELETE FROM affiliate_networks WHERE id = ${nid}`,
        );
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
