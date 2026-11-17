import "./_require-preview-db"; // MUST be first — refuses any target but the preview DB
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

// Stage-side creative brand rules (migration 0240, ClickUp 1amdve2d47v), over
// HTTP against a running server on the PREVIEW stack:
//
//   node scripts/with-preview-env.mjs npx next dev -p 3001        (one terminal)
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-creative-brand-stage-api.ts
//
// Asserts the check runs ONLY when a creative is picked or changed on a stage:
//   - stage POST with another brand's creative → 400 creative_brand_mismatch
//   - stage POST with a creative that has no brand → 400 creative_brand_unassigned
//   - stage PATCH switching to another brand's creative → 400
//   - stage PATCH echoing a SAVED creative whose brand no longer matches → 200
//     (saved stages keep their creative and keep sending — rule 4)
//   - stage POST / PATCH with a same-brand creative → 201 / 200
// Everything it creates is removed by id in `finally`.

import { createServerClient } from "@supabase/ssr";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  affiliate_networks,
  brands,
  campaigns,
  creatives,
  offers,
  provider_phones,
  sms_providers,
} from "../db/schema";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const appUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
  const testEmail = process.env.TEST_USER_EMAIL;
  const testPassword = process.env.TEST_USER_PASSWORD;
  if (!testEmail || !testPassword) throw new Error("Set TEST_USER_EMAIL/TEST_USER_PASSWORD.");

  const jar = new Map<string, string>();
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (cs) => cs.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const { error: signInErr } = await supabase.auth.signInWithPassword({ email: testEmail, password: testPassword });
  if (signInErr) throw new Error(`Sign-in failed: ${signInErr.message}`);
  const api = (path: string, init?: RequestInit) =>
    fetch(`${appUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
        Cookie: [...jar.entries()].map(([n, v]) => `${n}=${v}`).join("; "),
      },
    });

  let passed = 0;
  let failed = 0;
  const check = (name: string, ok: boolean, detail?: string) => {
    if (ok) passed++;
    else failed++;
    console.log(`  ${ok ? "✓" : "✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  };
  const reasonOf = async (r: Response) => ((await r.json()) as { details?: { reason?: string } }).details?.reason;

  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const db = drizzle(pg);
  const unique = Date.now();
  const made = { creatives: [] as number[], campaigns: [] as number[], offers: [] as number[], networks: [] as number[], brands: [] as number[] };

  try {
    // A provider + phone the org can send from, and the brand that phone belongs to.
    const [phone] = await db
      .select({ provider_id: provider_phones.provider_id, phone_id: provider_phones.id, brand_id: provider_phones.brand_id, org_id: sms_providers.org_id })
      .from(provider_phones)
      .innerJoin(sms_providers, eq(sms_providers.id, provider_phones.provider_id))
      .where(and(eq(provider_phones.status, "active"), eq(sms_providers.status, "active"), isNotNull(provider_phones.brand_id)))
      .limit(1);
    if (!phone || phone.brand_id == null) throw new Error("preview DB has no active provider phone with a brand");
    const brandA = phone.brand_id;
    const [brandARow] = await db.select({ name: brands.name }).from(brands).where(eq(brands.id, brandA));
    console.log(`scope: org ${phone.org_id} · campaign brand ${brandA} (${brandARow?.name}) · provider ${phone.provider_id} / phone ${phone.phone_id} · ${appUrl}`);
    const stageBody = (extra: Record<string, unknown>) =>
      JSON.stringify({ sms_provider_id: phone.provider_id, provider_phone_id: phone.phone_id, ...extra });

    // Seed: brand B, a network, one offer allowed under A, a draft campaign on A.
    const bR = await api("/api/brands", { method: "POST", body: JSON.stringify({ name: "Brand Rule Probe B", brand_id: `BRP-B-${unique}` }) });
    check("seed: brand B 201", bR.status === 201);
    const brandB = ((await bR.json()) as { id: number }).id;
    made.brands.push(brandB);
    const nR = await api("/api/networks", { method: "POST", body: JSON.stringify({ name: `BRP Net ${unique}`, network_id: `BRP-N-${unique}` }) });
    const network = ((await nR.json()) as { id: number }).id;
    made.networks.push(network);
    const oR = await api("/api/offers", {
      method: "POST",
      body: JSON.stringify({ name: `BRP Offer ${unique}`, offer_id: `BRP-O-${unique}`, network_id: network, payout_model: "cpa", payout_cpa: 10, brand_ids: [brandA, brandB] }),
    });
    check("seed: offer 201", oR.status === 201, `got ${oR.status}`);
    const offer = ((await oR.json()) as { id: number }).id;
    made.offers.push(offer);
    const cR = await api("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({ name: `BRP Campaign ${unique}`, brand_id: brandA, offer_id: offer, save_as_draft: true }),
    });
    check("seed: draft campaign 201", cR.status === 201, `got ${cR.status} ${cR.status === 201 ? "" : await cR.clone().text()}`);
    const campaign = ((await cR.json()) as { id: number }).id;
    made.campaigns.push(campaign);

    const mkCreative = async (brand: number, text: string) => {
      const r = await api("/api/creatives", { method: "POST", body: JSON.stringify({ text, brand_id: brand, offer_ids: [offer] }) });
      const id = ((await r.json()) as { id: number }).id;
      made.creatives.push(id);
      return { status: r.status, id };
    };
    const crA = await mkCreative(brandA, "Brand A creative");
    const crA2 = await mkCreative(brandA, "Brand A creative 2");
    const crB = await mkCreative(brandB, "Brand B creative");
    check("seed: creatives 201", [crA, crA2, crB].every((c) => c.status === 201));
    const [unbranded] = await db
      .insert(creatives)
      .values({ org_id: phone.org_id, text: "Unbranded", slug: `brp-${unique}`, status: "active" })
      .returning({ id: creatives.id });
    made.creatives.push(unbranded.id);

    console.log("\n[1] stage POST");
    const okR = await api(`/api/campaigns/${campaign}/stages`, { method: "POST", body: stageBody({ creative_id: crA.id }) });
    check("same-brand creative → 201", okR.status === 201, `got ${okR.status} ${okR.status === 201 ? "" : await okR.clone().text()}`);
    const stage = ((await okR.json()) as { id: number }).id;
    const misR = await api(`/api/campaigns/${campaign}/stages`, { method: "POST", body: stageBody({ creative_id: crB.id }) });
    check("another brand's creative → 400 creative_brand_mismatch", misR.status === 400 && (await reasonOf(misR)) === "creative_brand_mismatch", `got ${misR.status}`);
    const unR = await api(`/api/campaigns/${campaign}/stages`, { method: "POST", body: stageBody({ creative_id: unbranded.id }) });
    check("creative with no brand → 400 creative_brand_unassigned", unR.status === 400 && (await reasonOf(unR)) === "creative_brand_unassigned", `got ${unR.status}`);
    const noCrR = await api(`/api/campaigns/${campaign}/stages`, { method: "POST", body: stageBody({}) });
    check("stage with no creative → 201 (no check)", noCrR.status === 201, `got ${noCrR.status}`);

    console.log("\n[2] stage PATCH");
    const swR = await api(`/api/campaigns/${campaign}/stages/${stage}`, { method: "PATCH", body: JSON.stringify({ creative_id: crB.id }) });
    check("switching to another brand's creative → 400 creative_brand_mismatch", swR.status === 400 && (await reasonOf(swR)) === "creative_brand_mismatch", `got ${swR.status}`);
    const sw2R = await api(`/api/campaigns/${campaign}/stages/${stage}`, { method: "PATCH", body: JSON.stringify({ creative_id: crA2.id }) });
    check("switching to a same-brand creative → 200", sw2R.status === 200, `got ${sw2R.status}`);

    // The saved stage now holds crA2. Move crA2 to brand B behind its back — the
    // "already saved stage, creative of another brand" case — then edit the
    // stage while echoing its creative.
    await db.update(creatives).set({ brand_id: brandB }).where(eq(creatives.id, crA2.id));
    const echoR = await api(`/api/campaigns/${campaign}/stages/${stage}`, { method: "PATCH", body: JSON.stringify({ creative_id: crA2.id, label: "edited after brand move" }) });
    check("echoing a saved cross-brand creative → 200 (not re-validated)", echoR.status === 200, `got ${echoR.status} ${echoR.status === 200 ? "" : await echoR.clone().text()}`);
    const labelOnlyR = await api(`/api/campaigns/${campaign}/stages/${stage}`, { method: "PATCH", body: JSON.stringify({ label: "label only" }) });
    check("editing other fields of that stage → 200", labelOnlyR.status === 200, `got ${labelOnlyR.status}`);
  } finally {
    console.log("\ncleanup (by id)");
    try {
      if (made.campaigns.length) await db.delete(campaigns).where(inArray(campaigns.id, made.campaigns)); // stages cascade
      if (made.creatives.length) await db.delete(creatives).where(inArray(creatives.id, made.creatives));
      if (made.offers.length) await db.delete(offers).where(inArray(offers.id, made.offers));
      if (made.networks.length) await db.delete(affiliate_networks).where(inArray(affiliate_networks.id, made.networks));
      if (made.brands.length) await db.delete(brands).where(inArray(brands.id, made.brands));
      const left = await db.select({ id: creatives.id }).from(creatives).where(inArray(creatives.id, made.creatives.length ? made.creatives : [-1]));
      console.log(`  removed ${made.campaigns.length} campaigns, ${made.creatives.length} creatives, ${made.offers.length} offers, ${made.brands.length} brands; residue creatives: ${left.length}`);
    } finally {
      await supabase.auth.signOut({ scope: "local" });
      await pg.end({ timeout: 5 });
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
