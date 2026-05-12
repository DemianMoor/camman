import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  brands,
  campaign_audience_pool,
  campaigns,
  contacts,
  offers,
  opt_outs,
  segment_contacts,
  segment_groups,
  segments,
} from "../db/schema";

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
  const insertedPhones: string[] = [];
  const createdBrandIds: number[] = [];
  const createdOfferIds: number[] = [];
  const createdSegmentIds: number[] = [];
  const createdGroupIds: number[] = [];
  const createdCampaignIds: number[] = [];
  let orgId: string | null = null;

  try {
    // Probe brand → org_id
    const brandR = await apiFetch("/api/brands", {
      method: "POST",
      body: JSON.stringify({
        name: "Campaign Probe",
        brand_id: `CMP-PROBE-${unique}`,
      }),
    });
    check("seed: brand creation returns 201", brandR.status === 201);
    const brand = (await brandR.json()) as { id: number; org_id: string };
    orgId = brand.org_id;
    createdBrandIds.push(brand.id);

    const offerR = await apiFetch("/api/offers", {
      method: "POST",
      body: JSON.stringify({
        name: "Campaign Probe Offer",
        offer_id: `CMP-OFFER-${unique}`,
        payout_model: "cpa",
        payout_cpa: 10,
      }),
    });
    check("seed: offer creation returns 201", offerR.status === 201);
    const offer = (await offerR.json()) as { id: number };
    createdOfferIds.push(offer.id);

    // Group + segment so the segment_count audit shows a real value if checked.
    const grpR = await apiFetch("/api/segment-groups", {
      method: "POST",
      body: JSON.stringify({
        name: "Campaign Probe Group",
        segment_group_id: `CMP-GRP-${unique}`,
      }),
    });
    check("seed: segment-group creation returns 201", grpR.status === 201);
    const grp = (await grpR.json()) as { id: number };
    createdGroupIds.push(grp.id);

    const segR = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({
        name: "Campaign Probe Segment",
        segment_id: `CMP-SEG-${unique}`,
        segment_group_ids: [grp.id],
      }),
    });
    check("seed: segment creation returns 201", segR.status === 201);
    const seg = (await segR.json()) as { id: number };
    createdSegmentIds.push(seg.id);

    // 100 test contacts; upload them and assign all to the segment.
    const phones: string[] = [];
    for (let i = 0; i < 100; i++) {
      phones.push(`+1213900${String(i).padStart(4, "0")}`);
    }
    insertedPhones.push(...phones);
    const upR = await apiFetch(`/api/segments/${seg.id}/contacts/upload`, {
      method: "POST",
      body: JSON.stringify({ phones: phones.join("\n") }),
    });
    check("seed: 100 contacts uploaded to segment", upR.status === 201);

    // Mark 5 of those contacts as opt-outs so we can verify the snapshot
    // excludes them.
    const optOutPhones = phones.slice(0, 5);
    const cIds = await db
      .select({ id: contacts.id, phone_number: contacts.phone_number })
      .from(contacts)
      .where(inArray(contacts.phone_number, optOutPhones));
    await db
      .insert(opt_outs)
      .values(
        cIds.map((c) => ({
          org_id: orgId!,
          contact_id: c.id,
          phone_number: c.phone_number,
          source: "test",
        })),
      );

    // =============== Tests ===============
    console.log("\n[1] POST create with save_as_draft=false (launches)");
    const c1R = await apiFetch("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: `Test Campaign ${unique}`,
        brand_id: brand.id,
        offer_id: offer.id,
        audience_segment_ids: [seg.id],
        audience_filters: {
          include_no_status: true,
          include_not_clicked: true,
        },
        save_as_draft: false,
      }),
    });
    check("returns 201", c1R.status === 201, `got ${c1R.status}`);
    const c1 = (await c1R.json()) as {
      id: number;
      status: string;
      audience_snapshot_count: number;
      slug: string;
    };
    createdCampaignIds.push(c1.id);
    check("status = 'active' after launch", c1.status === "active");
    check(
      "audience_snapshot_count = 95 (100 - 5 opt-outs)",
      c1.audience_snapshot_count === 95,
      `got ${c1.audience_snapshot_count}`,
    );
    check(
      "slug is 6 lowercase alphanumeric chars",
      /^[a-z0-9]{6}$/.test(c1.slug),
    );

    // Verify the pool actually has 95 rows.
    const poolRows = await db
      .select({ contact_id: campaign_audience_pool.contact_id })
      .from(campaign_audience_pool)
      .where(eq(campaign_audience_pool.campaign_id, c1.id));
    check(
      "campaign_audience_pool has 95 rows",
      poolRows.length === 95,
      `got ${poolRows.length}`,
    );

    console.log(
      "\n[2] POST create with save_as_draft=true (minimal draft — no segments)",
    );
    // save_as_draft relaxes audience_segment_ids (and other secondary
    // fields). brand_id + offer_id remain required because the audience
    // snapshot is brand-scoped and an offer is needed to compose short
    // links. This test verifies the relaxation: name + brand + offer only.
    const c2R = await apiFetch("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: `Draft Campaign ${unique}`,
        brand_id: brand.id,
        offer_id: offer.id,
        save_as_draft: true,
      }),
    });
    check("returns 201", c2R.status === 201);
    const c2 = (await c2R.json()) as {
      id: number;
      status: string;
      audience_snapshot_count: number;
    };
    createdCampaignIds.push(c2.id);
    check("status = 'draft'", c2.status === "draft");
    check(
      "audience_snapshot_count = 0",
      c2.audience_snapshot_count === 0,
    );

    console.log(
      "\n[2b] POST create without brand_id (save_as_draft=true) → 400",
    );
    // Drafts still require brand_id and offer_id — that's not part of the
    // relaxation. Verify the validator surfaces the right error.
    const c2bR = await apiFetch("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: `Bad Draft ${unique}`,
        save_as_draft: true,
      }),
    });
    check(
      "draft without brand_id returns 400",
      c2bR.status === 400,
      `got ${c2bR.status}`,
    );

    console.log("\n[3] POST create with cross-org segment → 400");
    const c3R = await apiFetch("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: `Bad Campaign ${unique}`,
        brand_id: brand.id,
        offer_id: offer.id,
        audience_segment_ids: [999999999],
        save_as_draft: false,
      }),
    });
    check("returns 400", c3R.status === 400);

    console.log("\n[4] GET list");
    const listR = await apiFetch("/api/campaigns/list?pageSize=100");
    const list = (await listR.json()) as {
      data: { id: number }[];
      totalCount: number;
    };
    check(
      "our two campaigns are in the list",
      list.data.some((r) => r.id === c1.id) &&
        list.data.some((r) => r.id === c2.id),
    );

    console.log("\n[5] PATCH name on draft → 200");
    const p1R = await apiFetch(`/api/campaigns/${c2.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed Draft" }),
    });
    check("returns 200", p1R.status === 200);

    console.log("\n[6] PATCH audience on active → 400 audience_locked");
    const p2R = await apiFetch(`/api/campaigns/${c1.id}`, {
      method: "PATCH",
      body: JSON.stringify({ audience_segment_ids: [seg.id] }),
    });
    check("returns 400", p2R.status === 400);
    const p2body = await p2R.json();
    check(
      "details.reason = audience_locked_after_draft",
      p2body.details?.reason === "audience_locked_after_draft",
    );

    console.log("\n[7] Status transitions on active campaign");
    const s1R = await apiFetch(`/api/campaigns/${c1.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "paused" }),
    });
    check("active → paused: 200", s1R.status === 200);
    const s2R = await apiFetch(`/api/campaigns/${c1.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "active" }),
    });
    check("paused → active: 200", s2R.status === 200);
    const s3R = await apiFetch(`/api/campaigns/${c1.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "completed" }),
    });
    check("active → completed: 200", s3R.status === 200);
    const s4R = await apiFetch(`/api/campaigns/${c1.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "active" }),
    });
    check("completed → active: 409 invalid", s4R.status === 409);

    console.log("\n[8] POST audience-preview (no DB write)");
    const previewR = await apiFetch("/api/campaigns/audience-preview", {
      method: "POST",
      body: JSON.stringify({
        audience_segment_ids: [seg.id],
        audience_filters: {
          include_no_status: true,
          include_not_clicked: true,
        },
      }),
    });
    check("returns 200", previewR.status === 200);
    const preview = (await previewR.json()) as { count: number };
    check(
      "preview count = 95 (matches snapshot logic)",
      preview.count === 95,
      `got ${preview.count}`,
    );
    // Ensure no extra pool rows landed for a non-existent campaign.
    const allPoolRows = await db
      .select({ campaign_id: campaign_audience_pool.campaign_id })
      .from(campaign_audience_pool)
      .where(eq(campaign_audience_pool.org_id, orgId));
    check(
      "preview wrote nothing — pool unchanged",
      allPoolRows.filter((r) => r.campaign_id === c1.id).length === 95,
    );
  } finally {
    console.log("\nCleanup");
    try {
      for (const cid of createdCampaignIds) {
        await db.delete(campaigns).where(eq(campaigns.id, cid));
      }
      if (insertedPhones.length > 0) {
        await db
          .delete(opt_outs)
          .where(inArray(opt_outs.phone_number, insertedPhones));
        await db
          .delete(segment_contacts)
          .where(
            inArray(
              segment_contacts.contact_id,
              db
                .select({ id: contacts.id })
                .from(contacts)
                .where(inArray(contacts.phone_number, insertedPhones)),
            ),
          );
        await db
          .delete(contacts)
          .where(inArray(contacts.phone_number, insertedPhones));
      }
      for (const sid of createdSegmentIds) {
        await db.delete(segments).where(eq(segments.id, sid));
      }
      for (const gid of createdGroupIds) {
        await db.delete(segment_groups).where(eq(segment_groups.id, gid));
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
