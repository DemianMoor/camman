import "./_require-preview-db"; // MUST be first — refuses any target but the preview DB
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  affiliate_networks,
  brands,
  creatives,
  offer_brands,
  offers,
} from "../db/schema";
import { calculateSmsSegments } from "../lib/creative-helpers";

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
  const createdCreativeIds: number[] = [];
  const createdBrandIds: number[] = [];
  const createdOfferIds: number[] = [];
  const createdNetworkIds: number[] = [];

  // =============== SMS segment unit tests ===============
  console.log("\n[0] calculateSmsSegments unit tests");
  {
    const r = calculateSmsSegments("Hello");
    check(
      "'Hello' → GSM-7, 5 chars, 1 segment",
      r.charset === "GSM-7" &&
        r.characters === 5 &&
        r.segments === 1 &&
        r.per_segment_limit === 160,
    );
  }
  {
    const r = calculateSmsSegments("a".repeat(161));
    check(
      "161 GSM chars → 2 segments, 153-char limit",
      r.charset === "GSM-7" &&
        r.characters === 161 &&
        r.segments === 2 &&
        r.per_segment_limit === 153,
    );
  }
  {
    const r = calculateSmsSegments("Hello 🎉");
    check(
      "'Hello 🎉' → UCS-2 (emoji triggers it)",
      r.charset === "UCS-2" && r.segments === 1,
    );
  }

  try {
    // =============== Setup: brand + 3 offers ===============
    const brandR = await apiFetch("/api/brands", {
      method: "POST",
      body: JSON.stringify({
        name: "Creative Probe",
        brand_id: `CR-PROBE-${unique}`,
      }),
    });
    check("seed: brand 201", brandR.status === 201);
    const brand = (await brandR.json()) as { id: number };
    createdBrandIds.push(brand.id);

    // Networks are now required on offers.
    const netR = await apiFetch("/api/networks", {
      method: "POST",
      body: JSON.stringify({
        name: `Creative Probe Network ${unique}`,
        network_id: `CR-NET-${unique}`,
      }),
    });
    check("seed: network 201", netR.status === 201);
    const network = (await netR.json()) as { id: number };
    createdNetworkIds.push(network.id);

    async function createOffer(label: string): Promise<{ id: number }> {
      const r = await apiFetch("/api/offers", {
        method: "POST",
        body: JSON.stringify({
          name: `CR Offer ${label}`,
          offer_id: `CR-OFFER-${unique}-${label}`,
          network_id: network.id,
          payout_model: "cpa",
          payout_cpa: 10,
          brand_ids: [brand.id],
        }),
      });
      const o = (await r.json()) as { id: number };
      check(`seed: offer ${label} 201`, r.status === 201, `got ${r.status} ${JSON.stringify(o)}`);
      createdOfferIds.push(o.id);
      return o;
    }
    const offer1 = await createOffer("A");
    const offer2 = await createOffer("B");
    const offer3 = await createOffer("C");

    // ============ [1] Single create with one offer ============
    console.log("\n[1] Single create with one offer");
    const c1R = await apiFetch("/api/creatives", {
      method: "POST",
      body: JSON.stringify({
        brand_id: brand.id,
        text: "Single-offer creative",
        offer_ids: [offer1.id],
      }),
    });
    check("returns 201", c1R.status === 201);
    const c1 = (await c1R.json()) as {
      id: number;
      slug: string;
      status: string;
      offers: { id: number }[];
      applies_to_all_offers: boolean;
      brand_id: number | null;
      sequence_placement: string;
    };
    createdCreativeIds.push(c1.id);
    check("brand_id stored", c1.brand_id === brand.id, `got ${c1.brand_id}`);
    check("slug present", /^[a-z0-9]{6}$/.test(c1.slug), `got ${c1.slug}`);
    check("status defaults to 'active'", c1.status === "active");
    check(
      "offers array has 1 entry (offer1)",
      c1.offers.length === 1 && c1.offers[0].id === offer1.id,
    );
    check("applies_to_all_offers = false", c1.applies_to_all_offers === false);

    // ============ [2] Single create with multiple offers ============
    console.log("\n[2] Single create with multiple offers");
    const c2R = await apiFetch("/api/creatives", {
      method: "POST",
      body: JSON.stringify({
        brand_id: brand.id,
        text: "Multi-offer creative",
        offer_ids: [offer1.id, offer2.id, offer3.id],
      }),
    });
    check("returns 201", c2R.status === 201);
    const c2 = (await c2R.json()) as {
      id: number;
      slug: string;
      offers: { id: number }[];
    };
    createdCreativeIds.push(c2.id);
    check("offers array has 3 entries", c2.offers.length === 3);

    // ============ [3] applies_to_all_offers=true ============
    console.log("\n[3] Single create with applies_to_all_offers=true");
    const c3R = await apiFetch("/api/creatives", {
      method: "POST",
      body: JSON.stringify({
        brand_id: brand.id,
        text: "Org-wide creative",
        applies_to_all_offers: true,
      }),
    });
    check("returns 201", c3R.status === 201);
    const c3 = (await c3R.json()) as {
      id: number;
      applies_to_all_offers: boolean;
      offers: { id: number }[];
    };
    createdCreativeIds.push(c3.id);
    check("applies_to_all_offers = true", c3.applies_to_all_offers === true);
    check("offers array is empty (no junction rows)", c3.offers.length === 0);

    // ============ [4] Validation: no offers + applies_to_all=false ============
    console.log("\n[4] Validation: at least one offer association required");
    const c4R = await apiFetch("/api/creatives", {
      method: "POST",
      body: JSON.stringify({
        brand_id: brand.id,
        text: "Orphan",
        offer_ids: [],
        applies_to_all_offers: false,
      }),
    });
    check("returns 400", c4R.status === 400);
    const c4err = await c4R.json();
    check(
      "error mentions offer requirement",
      typeof c4err.error === "string" &&
        c4err.error.toLowerCase().includes("offer"),
    );

    // ============ [5] Bulk create ============
    console.log("\n[5] Bulk create — 3 creatives, shared brand + offer + sequence");
    const bulkR = await apiFetch("/api/creatives", {
      method: "POST",
      body: JSON.stringify({
        brand_id: brand.id,
        creatives: [{ text: "Bulk A" }, { text: "Bulk B" }, { text: "Bulk C" }],
        offer_ids: [offer1.id],
        sequence_placement: "1st",
      }),
    });
    check("returns 201", bulkR.status === 201);
    const bulk = (await bulkR.json()) as {
      created: Array<{
        id: number;
        offers: { id: number }[];
        brand_id: number | null;
        sequence_placement: string;
        text: string;
      }>;
    };
    for (const c of bulk.created) createdCreativeIds.push(c.id);
    check("3 creatives created", bulk.created.length === 3);
    check(
      "each has 1 junction row to offer1",
      bulk.created.every(
        (c) => c.offers.length === 1 && c.offers[0].id === offer1.id,
      ),
    );
    check(
      "each has the shared brand",
      bulk.created.every((c) => c.brand_id === brand.id),
    );
    check(
      "each has sequence_placement='1st'",
      bulk.created.every((c) => c.sequence_placement === "1st"),
    );
    check(
      "texts match input order",
      bulk.created[0].text === "Bulk A" &&
        bulk.created[1].text === "Bulk B" &&
        bulk.created[2].text === "Bulk C",
    );

    // ============ [6] Bulk create cap ============
    console.log("\n[6] Bulk create cap — 51 rows → 400");
    const over = await apiFetch("/api/creatives", {
      method: "POST",
      body: JSON.stringify({
        brand_id: brand.id,
        creatives: Array.from({ length: 51 }, (_, i) => ({ text: `r${i}` })),
        offer_ids: [offer1.id],
      }),
    });
    check("returns 400", over.status === 400);

    // ============ [7] Bulk transactional rollback ============
    console.log("\n[7] Bulk transactional rollback — invalid row aborts batch");
    // Snapshot the count of test creatives we own before the batch.
    const before = await db
      .select({ id: creatives.id })
      .from(creatives)
      .where(inArray(creatives.id, createdCreativeIds));
    const rollR = await apiFetch("/api/creatives", {
      method: "POST",
      body: JSON.stringify({
        brand_id: brand.id,
        creatives: [
          { text: "Valid row 1" },
          { text: "" }, // invalid — empty
          { text: "Valid row 3" },
        ],
        offer_ids: [offer1.id],
      }),
    });
    check("returns 400", rollR.status === 400);
    const after = await db
      .select({ id: creatives.id })
      .from(creatives)
      .where(inArray(creatives.id, createdCreativeIds));
    check(
      "no new creatives inserted from failed batch",
      after.length === before.length,
    );

    // ============ [8] PATCH offer_ids — replace semantics ============
    console.log("\n[8] PATCH offer_ids replace semantics");
    const c8R = await apiFetch("/api/creatives", {
      method: "POST",
      body: JSON.stringify({
        brand_id: brand.id,
        text: "Replace-semantics target",
        offer_ids: [offer1.id, offer2.id],
      }),
    });
    const c8 = (await c8R.json()) as { id: number };
    createdCreativeIds.push(c8.id);
    const pR = await apiFetch(`/api/creatives/${c8.id}`, {
      method: "PATCH",
      body: JSON.stringify({ offer_ids: [offer2.id, offer3.id] }),
    });
    check("PATCH returns 200", pR.status === 200);
    const pBody = (await pR.json()) as { offers: { id: number }[] };
    const ids = new Set(pBody.offers.map((o) => o.id));
    check(
      "result is exactly [offer2, offer3]",
      ids.size === 2 && ids.has(offer2.id) && ids.has(offer3.id),
      `got ${[...ids].join(",")}`,
    );

    // ============ [9] PATCH applies_to_all_offers toggle ============
    console.log("\n[9] PATCH applies_to_all_offers — junction rows preserved");
    const c9R = await apiFetch("/api/creatives", {
      method: "POST",
      body: JSON.stringify({
        brand_id: brand.id,
        text: "Toggle target",
        offer_ids: [offer1.id],
      }),
    });
    const c9 = (await c9R.json()) as { id: number };
    createdCreativeIds.push(c9.id);
    const toggleOnR = await apiFetch(`/api/creatives/${c9.id}`, {
      method: "PATCH",
      body: JSON.stringify({ applies_to_all_offers: true }),
    });
    check("toggle ON returns 200", toggleOnR.status === 200);
    const toggleOnBody = (await toggleOnR.json()) as {
      applies_to_all_offers: boolean;
      offers: { id: number }[];
    };
    check(
      "applies_to_all_offers = true",
      toggleOnBody.applies_to_all_offers === true,
    );
    check(
      "junction rows NOT auto-cleared",
      toggleOnBody.offers.length === 1 &&
        toggleOnBody.offers[0].id === offer1.id,
    );
    const toggleOffR = await apiFetch(`/api/creatives/${c9.id}`, {
      method: "PATCH",
      body: JSON.stringify({ applies_to_all_offers: false }),
    });
    const toggleOffBody = (await toggleOffR.json()) as {
      offers: { id: number }[];
    };
    check(
      "toggling back keeps original junction rows",
      toggleOffBody.offers.length === 1 &&
        toggleOffBody.offers[0].id === offer1.id,
    );

    // ============ [10] Stage picker eligibility ============
    console.log("\n[10] Stage picker eligibility via /api/creatives/list?offer_id=…");
    // c1: offer1 (created in [1]); c3: applies_to_all_offers=true; c2: [offer1, offer2, offer3]
    // We need a creative that is ONLY on offer2 (i.e. NOT offer1) to verify exclusion.
    const cOffer2OnlyR = await apiFetch("/api/creatives", {
      method: "POST",
      body: JSON.stringify({
        brand_id: brand.id,
        text: "Offer2-only creative",
        offer_ids: [offer2.id],
      }),
    });
    const cOffer2Only = (await cOffer2OnlyR.json()) as { id: number };
    createdCreativeIds.push(cOffer2Only.id);

    const pickR = await apiFetch(
      `/api/creatives/list?offer_id=${offer1.id}&status=active&pageSize=200`,
    );
    const pickBody = (await pickR.json()) as {
      data: { id: number; applies_to_all_offers: boolean }[];
    };
    const pickIds = new Set(pickBody.data.map((r) => r.id));
    check(
      "c1 (offer1 junction) is in the offer1 picker results",
      pickIds.has(c1.id),
    );
    check(
      "c3 (applies_to_all_offers) is in the offer1 picker results",
      pickIds.has(c3.id),
    );
    check(
      "cOffer2Only is NOT in the offer1 picker results",
      !pickIds.has(cOffer2Only.id),
    );

    // ============ [11] Sequence default ============
    console.log("\n[11] Defaults — POST without sequence → 'unknown'");
    const cDefR = await apiFetch("/api/creatives", {
      method: "POST",
      body: JSON.stringify({
        brand_id: brand.id,
        text: "Default-meta creative",
        offer_ids: [offer1.id],
      }),
    });
    const cDef = (await cDefR.json()) as {
      id: number;
      sequence_placement: string;
    };
    createdCreativeIds.push(cDef.id);
    check(
      "sequence_placement defaults to 'unknown'",
      cDef.sequence_placement === "unknown",
    );

    // ============ [12] Archive + restore ============
    console.log("\n[12] Archive + restore");
    const archR = await apiFetch(`/api/creatives/${c1.id}/archive`, {
      method: "POST",
    });
    check("archive 200", archR.status === 200);
    const archived = (await archR.json()) as { status: string };
    check("status is 'archived'", archived.status === "archived");
    // Hidden in default list
    const defListR = await apiFetch("/api/creatives/list?pageSize=200");
    const defList = (await defListR.json()) as { data: { id: number }[] };
    check(
      "archived row hidden from default list",
      !defList.data.some((r) => r.id === c1.id),
    );
    // Shown when showArchived=true
    const showR = await apiFetch(
      "/api/creatives/list?showArchived=true&pageSize=200",
    );
    const showBody = (await showR.json()) as { data: { id: number }[] };
    check(
      "archived row visible with showArchived=true",
      showBody.data.some((r) => r.id === c1.id),
    );
    // Restore → status=active
    const resR = await apiFetch(`/api/creatives/${c1.id}/restore`, {
      method: "POST",
    });
    check("restore 200", resR.status === 200);
    const restored = (await resR.json()) as { status: string };
    check("restore sets status back to 'active'", restored.status === "active");

    // ============ [13] Copy to brand (0240) ============
    // The duplicate route takes a REQUIRED brand_id and keeps only the source
    // offers that brand may run (offer_brands). c2 has offers A, B, C; only C is
    // assigned to brand 2.
    console.log("\n[13] Copy to brand");
    const brand2R = await apiFetch("/api/brands", {
      method: "POST",
      body: JSON.stringify({ name: "Creative Probe 2", brand_id: `CR-PROBE2-${unique}` }),
    });
    check("seed: brand 2 201", brand2R.status === 201);
    const brand2 = (await brand2R.json()) as { id: number; org_id: string };
    createdBrandIds.push(brand2.id);
    await db.insert(offer_brands).values({ org_id: brand2.org_id, offer_id: offer3.id, brand_id: brand2.id });

    const noBrandDupR = await apiFetch(`/api/creatives/${c2.id}/duplicate`, { method: "POST", body: JSON.stringify({}) });
    check("copy without brand_id → 400", noBrandDupR.status === 400, `got ${noBrandDupR.status}`);

    const dupR = await apiFetch(`/api/creatives/${c2.id}/duplicate`, {
      method: "POST",
      body: JSON.stringify({ brand_id: brand2.id }),
    });
    check("copy to brand 2 → 201", dupR.status === 201, `got ${dupR.status}`);
    const dup = (await dupR.json()) as {
      id: number;
      slug: string;
      brand_id: number | null;
      offers: { id: number }[];
      dropped_offer_ids: number[];
    };
    createdCreativeIds.push(dup.id);
    check("copy has different id + slug", dup.id !== c2.id && dup.slug !== c2.slug);
    check("copy belongs to brand 2", dup.brand_id === brand2.id, `got ${dup.brand_id}`);
    check(
      "copy keeps only the offer allowed under brand 2 (C)",
      dup.offers.length === 1 && dup.offers[0].id === offer3.id,
      `got ${JSON.stringify(dup.offers.map((o) => o.id))}`,
    );
    check(
      "response names the dropped offers (A, B)",
      [...dup.dropped_offer_ids].sort((a, b) => a - b).join(",") ===
        [offer1.id, offer2.id].sort((a, b) => a - b).join(","),
      `got ${JSON.stringify(dup.dropped_offer_ids)}`,
    );

    const refuseR = await apiFetch(`/api/creatives/${c1.id}/duplicate`, {
      method: "POST",
      body: JSON.stringify({ brand_id: brand2.id }),
    });
    const refuse = (await refuseR.json()) as { details?: { reason?: string } };
    check(
      "copy where no offer is allowed under the brand → 400 no_offer_allowed_under_brand",
      refuseR.status === 400 && refuse.details?.reason === "no_offer_allowed_under_brand",
      `got ${refuseR.status} ${JSON.stringify(refuse)}`,
    );

    const sameBrandR = await apiFetch(`/api/creatives/${c2.id}/duplicate`, {
      method: "POST",
      body: JSON.stringify({ brand_id: brand.id }),
    });
    const sameBrand = (await sameBrandR.json()) as { id: number; offers: { id: number }[] };
    createdCreativeIds.push(sameBrand.id);
    check("copy to the same brand keeps all 3 offers", sameBrandR.status === 201 && sameBrand.offers.length === 3);

    // ============ [14] Brand reassignment (admin/owner) + list filter ============
    console.log("\n[14] Brand reassignment + list brand filter");
    const echoR = await apiFetch(`/api/creatives/${cDef.id}`, {
      method: "PATCH",
      body: JSON.stringify({ brand_id: brand.id, funnel_stage: "start" }),
    });
    check("PATCH echoing the stored brand → 200", echoR.status === 200, `got ${echoR.status}`);
    const moveR = await apiFetch(`/api/creatives/${cDef.id}`, {
      method: "PATCH",
      body: JSON.stringify({ brand_id: brand2.id }),
    });
    const moved = (await moveR.json()) as { brand_id: number | null };
    check(
      "owner PATCH moving the creative to brand 2 → 200 and stored",
      moveR.status === 200 && moved.brand_id === brand2.id,
      `got ${moveR.status} brand ${moved.brand_id}`,
    );
    const listR = await apiFetch(`/api/creatives/list?brand_id=${brand2.id}&include_metrics=false&pageSize=100`);
    const list = (await listR.json()) as { data: { id: number; brand_name: string | null }[] };
    check(
      "list brand filter returns only brand-2 creatives, with brand_name",
      list.data.some((c) => c.id === cDef.id && c.brand_name === "Creative Probe 2") &&
        list.data.every((c) => c.id !== c1.id),
      `got ${JSON.stringify(list.data.map((c) => c.id))}`,
    );
    const sortR = await apiFetch(`/api/creatives/list?sortBy=brand&sortDir=asc&include_metrics=false&pageSize=500&showArchived=true`);
    check("list sortBy=brand → 200", sortR.status === 200, `got ${sortR.status}`);
  } finally {
    console.log("\nCleanup");
    try {
      // creative_offers CASCADE off creatives — explicit delete of creatives
      // wipes their junction rows too.
      for (const cid of createdCreativeIds) {
        await db.delete(creatives).where(eq(creatives.id, cid));
      }
      for (const oid of createdOfferIds) {
        await db.delete(offers).where(eq(offers.id, oid));
      }
      for (const nid of createdNetworkIds) {
        await db.delete(affiliate_networks).where(eq(affiliate_networks.id, nid));
      }
      for (const bid of createdBrandIds) {
        await db.delete(brands).where(eq(brands.id, bid));
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
