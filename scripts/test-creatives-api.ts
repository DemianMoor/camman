import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { brands, creatives, offers, sms_providers } from "../db/schema";
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
  const createdCreativeIds: number[] = [];
  const createdBrandIds: number[] = [];
  const createdOfferIds: number[] = [];
  const createdProviderIds: number[] = [];

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
    const r = calculateSmsSegments("a".repeat(160));
    check(
      "160 GSM chars → 1 segment, 0 remaining",
      r.charset === "GSM-7" &&
        r.characters === 160 &&
        r.segments === 1 &&
        r.remaining_in_segment === 0,
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
  {
    // 70 UTF-16 code units of plain UCS-2 text (Chinese chars are 1 code unit each).
    const r = calculateSmsSegments("中".repeat(70));
    check(
      "70 UCS-2 chars → 1 segment, 0 remaining",
      r.charset === "UCS-2" &&
        r.characters === 70 &&
        r.segments === 1 &&
        r.remaining_in_segment === 0,
    );
  }
  {
    const r = calculateSmsSegments("中".repeat(71));
    check(
      "71 UCS-2 chars → 2 segments, 67-char limit",
      r.charset === "UCS-2" &&
        r.characters === 71 &&
        r.segments === 2 &&
        r.per_segment_limit === 67,
    );
  }
  {
    // GSM-7 extension chars count as 2.
    const r = calculateSmsSegments("{}");
    check(
      "GSM-7 extension chars count as 2",
      r.charset === "GSM-7" && r.characters === 4 && r.segments === 1,
      `characters=${r.characters}`,
    );
  }

  try {
    // =============== Setup: brand + offer + provider ===============
    const brandR = await apiFetch("/api/brands", {
      method: "POST",
      body: JSON.stringify({
        name: "Creative Probe",
        brand_id: `CR-PROBE-${unique}`,
      }),
    });
    check("seed: brand creation returns 201", brandR.status === 201);
    const brand = (await brandR.json()) as { id: number };
    createdBrandIds.push(brand.id);

    const offerR = await apiFetch("/api/offers", {
      method: "POST",
      body: JSON.stringify({
        name: "Creative Probe Offer",
        offer_id: `CR-OFFER-${unique}`,
        payout_model: "cpa",
        payout_cpa: 10,
      }),
    });
    check("offer creation returns 201", offerR.status === 201);
    const offer = (await offerR.json()) as { id: number };
    createdOfferIds.push(offer.id);

    const provR = await apiFetch("/api/providers", {
      method: "POST",
      body: JSON.stringify({
        name: "Creative Probe Provider",
        sms_provider_id: `CR-PROV-${unique}`,
      }),
    });
    check("seed: provider creation returns 201", provR.status === 201);
    const prov = (await provR.json()) as { id: number };
    createdProviderIds.push(prov.id);

    // =============== Create + slug ===============
    console.log("\n[1] POST create creative");
    const c1R = await apiFetch("/api/creatives", {
      method: "POST",
      body: JSON.stringify({
        offer_id: offer.id,
        brand_id: brand.id,
        sms_provider_id: prov.id,
        text: "Hello from {brand}!",
      }),
    });
    check("returns 201", c1R.status === 201);
    const c1 = (await c1R.json()) as {
      id: number;
      slug: string;
      status: string;
    };
    createdCreativeIds.push(c1.id);
    check(
      "slug is 6 lowercase alphanumeric chars",
      /^[a-z0-9]{6}$/.test(c1.slug),
      `got ${c1.slug}`,
    );
    check("status defaults to 'draft'", c1.status === "draft");

    console.log("\n[2] GET [id] returns joined offer/brand/provider");
    const getR = await apiFetch(`/api/creatives/${c1.id}`);
    const detail = (await getR.json()) as {
      offer: { id: number } | null;
      brand: { id: number } | null;
      provider: { id: number } | null;
    };
    check(
      "joined offer/brand/provider present",
      detail.offer?.id === offer.id &&
        detail.brand?.id === brand.id &&
        detail.provider?.id === prov.id,
    );

    console.log("\n[3] PATCH text while draft → 200");
    const p1R = await apiFetch(`/api/creatives/${c1.id}`, {
      method: "PATCH",
      body: JSON.stringify({ text: "Updated message" }),
    });
    check("PATCH returns 200", p1R.status === 200);

    console.log("\n[4] Status draft → pending");
    const s1R = await apiFetch(`/api/creatives/${c1.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "pending" }),
    });
    check("returns 200", s1R.status === 200);
    check(
      "status is now 'pending'",
      ((await s1R.json()) as { status: string }).status === "pending",
    );

    console.log("\n[5] PATCH text while pending → 200 (still editable)");
    const p2R = await apiFetch(`/api/creatives/${c1.id}`, {
      method: "PATCH",
      body: JSON.stringify({ text: "Edited during pending" }),
    });
    check("PATCH text returns 200 while pending", p2R.status === 200);

    console.log("\n[6] Status pending → ready (manager approval)");
    const s2R = await apiFetch(`/api/creatives/${c1.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "ready" }),
    });
    check("returns 200", s2R.status === 200);

    console.log("\n[7] PATCH text while ready → 400 (text locked)");
    const p3R = await apiFetch(`/api/creatives/${c1.id}`, {
      method: "PATCH",
      body: JSON.stringify({ text: "Should be blocked" }),
    });
    check("returns 400", p3R.status === 400);
    const p3body = await p3R.json();
    check(
      "error mentions text lock",
      p3body.details?.reason === "text_locked",
      `got ${JSON.stringify(p3body.details)}`,
    );

    console.log("\n[8] PATCH offer/brand while ready → 200 (still editable)");
    const p4R = await apiFetch(`/api/creatives/${c1.id}`, {
      method: "PATCH",
      body: JSON.stringify({ brand_id: null }),
    });
    check("returns 200", p4R.status === 200);

    console.log("\n[9] Status ready → paused → ready");
    const s3R = await apiFetch(`/api/creatives/${c1.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "paused" }),
    });
    check("paused returns 200", s3R.status === 200);
    const s4R = await apiFetch(`/api/creatives/${c1.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "ready" }),
    });
    check("paused → ready returns 200", s4R.status === 200);

    console.log("\n[10] Status ready → draft → 409 invalid transition");
    const s5R = await apiFetch(`/api/creatives/${c1.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "draft" }),
    });
    check("returns 409", s5R.status === 409);
    const s5body = await s5R.json();
    check(
      "details.reason = invalid_transition",
      s5body.details?.reason === "invalid_transition",
    );

    console.log("\n[11] Archive → 200, status becomes 'archived'");
    const archR = await apiFetch(`/api/creatives/${c1.id}/archive`, {
      method: "POST",
    });
    check("archive returns 200", archR.status === 200);
    const archived = (await archR.json()) as { status: string };
    check("status is 'archived'", archived.status === "archived");

    console.log("\n[12] Status transition on archived → 409");
    const s6R = await apiFetch(`/api/creatives/${c1.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "ready" }),
    });
    check("returns 409", s6R.status === 409);

    console.log("\n[13] Restore → status returns to 'draft'");
    const resR = await apiFetch(`/api/creatives/${c1.id}/restore`, {
      method: "POST",
    });
    check("restore returns 200", resR.status === 200);
    const restored = (await resR.json()) as { status: string };
    check("status is back to 'draft'", restored.status === "draft");

    console.log("\n[14] Duplicate creates an independent record");
    const dupR = await apiFetch(`/api/creatives/${c1.id}/duplicate`, {
      method: "POST",
    });
    check("duplicate returns 201", dupR.status === 201);
    const dup = (await dupR.json()) as {
      id: number;
      slug: string;
      status: string;
      text: string;
    };
    createdCreativeIds.push(dup.id);
    check("dup is a different id", dup.id !== c1.id);
    check("dup has a different slug", dup.slug !== c1.slug);
    check("dup starts as draft", dup.status === "draft");

    // Editing the duplicate must not affect the original.
    await apiFetch(`/api/creatives/${dup.id}`, {
      method: "PATCH",
      body: JSON.stringify({ text: "Duplicate-only change" }),
    });
    const origNowR = await apiFetch(`/api/creatives/${c1.id}`);
    const origNow = (await origNowR.json()) as { text: string };
    check(
      "editing dup does not change original text",
      origNow.text !== "Duplicate-only change",
    );

    console.log("\n[15] List filters by status");
    const listR = await apiFetch(
      `/api/creatives/list?status=draft&pageSize=100`,
    );
    const listBody = (await listR.json()) as {
      data: { id: number; status: string }[];
    };
    check(
      "list with status=draft returns only drafts",
      listBody.data.every((r) => r.status === "draft"),
    );
    check(
      "our two test rows are in the draft list",
      listBody.data.some((r) => r.id === c1.id) &&
        listBody.data.some((r) => r.id === dup.id),
    );
  } finally {
    console.log("\nCleanup");
    try {
      for (const cid of createdCreativeIds) {
        await db.delete(creatives).where(eq(creatives.id, cid));
      }
      for (const pid of createdProviderIds) {
        await db.delete(sms_providers).where(eq(sms_providers.id, pid));
      }
      for (const oid of createdOfferIds) {
        await db.delete(offers).where(eq(offers.id, oid));
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
