import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import Papa from "papaparse";
import postgres from "postgres";

import {
  brands,
  campaign_stages,
  campaigns,
  clicks,
  contacts,
  link_destinations,
  links,
  short_domains,
} from "../db/schema";

// Verifies the tracked-clicker export (GET /api/campaigns/[id]/export-clickers):
//   * default (clean) returns HUMAN, SCORED contacts only — bot/prefetch/suspect
//     and unscored rows are excluded
//   * include=all returns every clicking contact
//   * one row per distinct contact (deduped by phone), with a click count
//   * stage_id scopes to a single stage
//   * manual (non-tracked) campaign is rejected with 409 not_tracked
//
// Fixtures are seeded directly via the DB (no public mint API), then torn down.

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

  // Parse a CSV export into { phone -> { clicks } } for our seeded phones.
  function exportPhones(csvText: string): Map<string, number> {
    const rows = Papa.parse<string[]>(csvText, { skipEmptyLines: true }).data;
    const header = rows[0] ?? [];
    const phoneIdx = header.indexOf("Phone Number");
    const clicksIdx = header.indexOf("Clicks");
    const m = new Map<string, number>();
    for (const r of rows.slice(1)) {
      m.set(r[phoneIdx], Number(r[clicksIdx]));
    }
    return m;
  }

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);
  const unique = Date.now();

  // 10-digit (post-export) phones for our 5 seeded contacts. Distinctive prefix.
  const PH = {
    a: "9990001111",
    b: "9990002222",
    c: "9990003333",
    d: "9990004444",
    e: "9990005555",
  };
  const e164 = (p: string) => `+1${p}`;

  let orgId = "";
  let brandId = 0;
  let trackedCampaignId = 0;
  let manualCampaignId = 0;

  try {
    // Probe brand to discover org_id.
    const probeR = await apiFetch("/api/brands", {
      method: "POST",
      body: JSON.stringify({
        name: `ClickExport Probe ${unique}`,
        brand_id: `CLK-PROBE-${unique}`,
      }),
    });
    if (probeR.status !== 201) {
      console.error("Couldn't create probe brand", await probeR.text());
      process.exit(1);
    }
    const probe = (await probeR.json()) as { id: number; org_id: string };
    orgId = probe.org_id;
    brandId = probe.id;

    console.log("\n[setup] Seed tracked campaign + 2 stages + links + clicks");

    const [sd] = await db
      .insert(short_domains)
      .values({
        org_id: orgId,
        brand_id: brandId,
        domain: `clk${unique}.test`,
        status: "active",
      })
      .returning({ id: short_domains.id });

    const [dest] = await db
      .insert(link_destinations)
      .values({
        org_id: orgId,
        url: `https://example.test/${unique}`,
        url_hash: `hash-${unique}`,
      })
      .returning({ id: link_destinations.id });

    const trackingId = `CLKTEST_${unique}`;
    const [camp] = await db
      .insert(campaigns)
      .values({
        org_id: orgId,
        slug: `clk-tracked-${unique}`,
        name: `Click Export Tracked ${unique}`,
        brand_id: brandId,
        status: "active",
        link_mode: "tracked",
        tracking_id: trackingId,
      })
      .returning({ id: campaigns.id });
    trackedCampaignId = camp.id;

    const [manualCamp] = await db
      .insert(campaigns)
      .values({
        org_id: orgId,
        slug: `clk-manual-${unique}`,
        name: `Click Export Manual ${unique}`,
        status: "active",
        link_mode: "manual",
      })
      .returning({ id: campaigns.id });
    manualCampaignId = manualCamp.id;

    const [stage1] = await db
      .insert(campaign_stages)
      .values({
        org_id: orgId,
        campaign_id: trackedCampaignId,
        stage_number: 1,
        tracking_id: `${trackingId}_s1_c1`,
      })
      .returning({ id: campaign_stages.id });
    const [stage2] = await db
      .insert(campaign_stages)
      .values({
        org_id: orgId,
        campaign_id: trackedCampaignId,
        stage_number: 2,
        tracking_id: `${trackingId}_s2_c1`,
      })
      .returning({ id: campaign_stages.id });

    // 5 contacts.
    const contactRows = await db
      .insert(contacts)
      .values(
        [PH.a, PH.b, PH.c, PH.d, PH.e].map((p) => ({
          org_id: orgId,
          phone_number: e164(p),
        })),
      )
      .returning({ id: contacts.id, phone_number: contacts.phone_number });
    const cId = (p: string) =>
      contactRows.find((r) => r.phone_number === e164(p))!.id;

    // Helper to mint a link for (stage, contact).
    let linkSeq = 0;
    async function mkLink(stageId: number, stageNo: number, contactPhone: string) {
      linkSeq++;
      const [l] = await db
        .insert(links)
        .values({
          org_id: orgId,
          code: `clk${unique}-${linkSeq}`,
          short_domain_id: sd.id,
          destination_id: dest.id,
          campaign_id: trackedCampaignId,
          stage_id: stageId,
          contact_id: cId(contactPhone),
          send_token: `tok-${unique}-${linkSeq}`,
          campaign_tracking_id: trackingId,
          stage_tracking_id: `${trackingId}_s${stageNo}_c1`,
        })
        .returning({ id: links.id });
      return l.id;
    }

    // Stage 1 links.
    const lA = await mkLink(stage1.id, 1, PH.a);
    const lB = await mkLink(stage1.id, 1, PH.b);
    const lC = await mkLink(stage1.id, 1, PH.c);
    const lD = await mkLink(stage1.id, 1, PH.d);
    // Stage 2 link.
    const lE = await mkLink(stage2.id, 2, PH.e);

    const now = new Date();
    // Clicks: A human×2 (scored, dedup test), B bot, C prefetch (both scored),
    // D human but UNSCORED, E human scored (stage 2).
    await db.insert(clicks).values([
      { org_id: orgId, link_id: lA, classification: "human", scored_at: now },
      { org_id: orgId, link_id: lA, classification: "human", scored_at: now },
      { org_id: orgId, link_id: lB, classification: "bot", scored_at: now },
      { org_id: orgId, link_id: lC, classification: "prefetch", scored_at: now },
      // D: first-pass classified human but NEVER scored → must be excluded from clean.
      { org_id: orgId, link_id: lD, classification: "human", scored_at: null },
      { org_id: orgId, link_id: lE, classification: "human", scored_at: now },
    ]);

    // ---- [1] Default (clean): human + scored only, deduped across campaign ----
    console.log("\n[1] Default export (clean = human + scored)");
    const cleanR = await apiFetch(
      `/api/campaigns/${trackedCampaignId}/export-clickers`,
    );
    check("returns 200", cleanR.status === 200);
    check(
      "Content-Type is text/csv",
      (cleanR.headers.get("content-type") ?? "").startsWith("text/csv"),
    );
    const cleanDisp = cleanR.headers.get("content-disposition") ?? "";
    check(
      "filename reflects tracking_id + clean",
      cleanDisp.includes(`${trackingId}_clickers_clean.csv`),
      cleanDisp,
    );
    const clean = exportPhones(await cleanR.text());
    check(
      "clean has exactly contacts A and E",
      clean.has(PH.a) && clean.has(PH.e) && clean.size === 2,
      `phones=${[...clean.keys()].join(",")}`,
    );
    check("bot (B) excluded from clean", !clean.has(PH.b));
    check("prefetch (C) excluded from clean", !clean.has(PH.c));
    check("unscored-human (D) excluded from clean", !clean.has(PH.d));
    check(
      "contact A deduped to one row with clicks=2",
      clean.get(PH.a) === 2,
      `clicks=${clean.get(PH.a)}`,
    );

    // ---- [2] include=all: every clicking contact ----
    console.log("\n[2] include=all");
    const allR = await apiFetch(
      `/api/campaigns/${trackedCampaignId}/export-clickers?include=all`,
    );
    check("returns 200", allR.status === 200);
    check(
      "filename reflects all",
      (allR.headers.get("content-disposition") ?? "").includes(
        `${trackingId}_clickers_all.csv`,
      ),
    );
    const all = exportPhones(await allR.text());
    check(
      "all has A, B, C, D, E (5 contacts)",
      [PH.a, PH.b, PH.c, PH.d, PH.e].every((p) => all.has(p)) && all.size === 5,
      `phones=${[...all.keys()].join(",")}`,
    );

    // ---- [3] stage scoping ----
    console.log("\n[3] stage_id scoping");
    const s1cleanR = await apiFetch(
      `/api/campaigns/${trackedCampaignId}/export-clickers?stage_id=${stage1.id}`,
    );
    const s1clean = exportPhones(await s1cleanR.text());
    check(
      "stage1 clean = A only (E is stage2, D unscored)",
      s1clean.has(PH.a) && s1clean.size === 1,
      `phones=${[...s1clean.keys()].join(",")}`,
    );
    check(
      "stage1 filename includes _s1_",
      (s1cleanR.headers.get("content-disposition") ?? "").includes(
        `${trackingId}_s1_clickers_clean.csv`,
      ),
    );

    const s1allR = await apiFetch(
      `/api/campaigns/${trackedCampaignId}/export-clickers?stage_id=${stage1.id}&include=all`,
    );
    const s1all = exportPhones(await s1allR.text());
    check(
      "stage1 all = A, B, C, D (4 contacts, no stage-2 E)",
      [PH.a, PH.b, PH.c, PH.d].every((p) => s1all.has(p)) &&
        !s1all.has(PH.e) &&
        s1all.size === 4,
      `phones=${[...s1all.keys()].join(",")}`,
    );

    const s2cleanR = await apiFetch(
      `/api/campaigns/${trackedCampaignId}/export-clickers?stage_id=${stage2.id}`,
    );
    const s2clean = exportPhones(await s2cleanR.text());
    check(
      "stage2 clean = E only",
      s2clean.has(PH.e) && s2clean.size === 1,
      `phones=${[...s2clean.keys()].join(",")}`,
    );

    // ---- [4] manual campaign rejected ----
    console.log("\n[4] Manual (non-tracked) campaign → 409 not_tracked");
    const manualR = await apiFetch(
      `/api/campaigns/${manualCampaignId}/export-clickers`,
    );
    check("returns 409", manualR.status === 409, `got ${manualR.status}`);
    const manualBody = (await manualR.json()) as {
      details?: { reason?: string };
    };
    check(
      "reason = not_tracked",
      manualBody.details?.reason === "not_tracked",
      JSON.stringify(manualBody),
    );

    // ---- [5] error / scoping guards ----
    console.log("\n[5] Guards");
    const notFoundR = await apiFetch(
      `/api/campaigns/99999999/export-clickers`,
    );
    check("unknown campaign → 404", notFoundR.status === 404);

    const foreignStageR = await apiFetch(
      `/api/campaigns/${trackedCampaignId}/export-clickers?stage_id=99999999`,
    );
    check("foreign/unknown stage → 404", foreignStageR.status === 404);

    const unauthR = await fetch(
      `${appUrl}/api/campaigns/${trackedCampaignId}/export-clickers`,
    );
    check("unauthenticated → 401", unauthR.status === 401);
  } finally {
    console.log("\nCleanup");
    try {
      // Deleting the campaign cascades to stages → links → clicks (and the
      // campaign → links FK). Then the supporting rows that don't cascade.
      if (trackedCampaignId)
        await db.delete(campaigns).where(eq(campaigns.id, trackedCampaignId));
      if (manualCampaignId)
        await db.delete(campaigns).where(eq(campaigns.id, manualCampaignId));
      // Only our seeded contacts — never a broad org-wide delete.
      const seededPhones = [PH.a, PH.b, PH.c, PH.d, PH.e].map(e164);
      await db
        .delete(contacts)
        .where(inArray(contacts.phone_number, seededPhones));
      if (brandId) {
        await db.delete(short_domains).where(eq(short_domains.brand_id, brandId));
        await db
          .delete(link_destinations)
          .where(eq(link_destinations.url, `https://example.test/${unique}`));
        await db.delete(brands).where(eq(brands.id, brandId));
      }
      console.log("  cleanup complete");
    } catch (e) {
      console.error("  cleanup error:", e);
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
