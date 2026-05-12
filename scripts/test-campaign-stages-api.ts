import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  brands,
  campaigns,
  contacts,
  creatives,
  offers,
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
  const createdBrandIds: number[] = [];
  const createdOfferIds: number[] = [];
  const createdSegmentIds: number[] = [];
  const createdGroupIds: number[] = [];
  const createdCampaignIds: number[] = [];
  const createdCreativeIds: number[] = [];
  const insertedPhones: string[] = [];

  try {
    // Setup: brand + offer + segment with 10 contacts + campaign + creative
    const brandR = await apiFetch("/api/brands", {
      method: "POST",
      body: JSON.stringify({
        name: "Stage Test Brand",
        brand_id: `STG-B-${unique}`,
      }),
    });
    check("seed: brand creation returns 201", brandR.status === 201);
    const brand = (await brandR.json()) as { id: number };
    createdBrandIds.push(brand.id);

    const offerR = await apiFetch("/api/offers", {
      method: "POST",
      body: JSON.stringify({
        name: "Stage Test Offer",
        offer_id: `STG-O-${unique}`,
        payout_model: "cpa",
        payout_cpa: 10,
      }),
    });
    check("seed: offer creation returns 201", offerR.status === 201);
    const offer = (await offerR.json()) as { id: number };
    createdOfferIds.push(offer.id);

    const grpR = await apiFetch("/api/segment-groups", {
      method: "POST",
      body: JSON.stringify({
        name: "Stage Group",
        segment_group_id: `STG-G-${unique}`,
      }),
    });
    check("seed: segment-group creation returns 201", grpR.status === 201);
    const grp = (await grpR.json()) as { id: number };
    createdGroupIds.push(grp.id);

    const segR = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({
        name: "Stage Test Segment",
        segment_id: `STG-S-${unique}`,
        segment_group_ids: [grp.id],
      }),
    });
    check("seed: segment creation returns 201", segR.status === 201);
    const seg = (await segR.json()) as { id: number };
    createdSegmentIds.push(seg.id);

    const phones: string[] = [];
    for (let i = 0; i < 10; i++) {
      phones.push(`+1212555${String(i).padStart(4, "0")}`);
    }
    insertedPhones.push(...phones);
    const uploadR = await apiFetch(
      `/api/segments/${seg.id}/contacts/upload`,
      {
        method: "POST",
        body: JSON.stringify({ phones: phones.join("\n") }),
      },
    );
    check("seed: contacts upload returns 201", uploadR.status === 201);

    const campR = await apiFetch("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: `Stage Test Campaign ${unique}`,
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
    check("seed: campaign creation returns 201", campR.status === 201);
    const campaign = (await campR.json()) as { id: number };
    createdCampaignIds.push(campaign.id);

    const creR = await apiFetch("/api/creatives", {
      method: "POST",
      body: JSON.stringify({
        offer_id: offer.id,
        brand_id: brand.id,
        text: "Stage test SMS body",
      }),
    });
    check("seed: creative creation returns 201", creR.status === 201);
    const cre = (await creR.json()) as { id: number };
    createdCreativeIds.push(cre.id);

    // =============== Tests ===============
    console.log("\n[1] POST stage 1 with creative_id");
    const s1R = await apiFetch(`/api/campaigns/${campaign.id}/stages`, {
      method: "POST",
      body: JSON.stringify({ creative_id: cre.id }),
    });
    check("returns 201", s1R.status === 201, `got ${s1R.status}`);
    const s1 = (await s1R.json()) as { id: number; stage_number: number };
    check("stage_number = 1 (trigger assigned)", s1.stage_number === 1);

    console.log("\n[2] POST stage 2");
    const s2R = await apiFetch(`/api/campaigns/${campaign.id}/stages`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    check("returns 201", s2R.status === 201);
    const s2 = (await s2R.json()) as { id: number; stage_number: number };
    check("stage_number = 2", s2.stage_number === 2);

    console.log("\n[3] POST stage with conflicting clicker flags → 400");
    const s3R = await apiFetch(`/api/campaigns/${campaign.id}/stages`, {
      method: "POST",
      body: JSON.stringify({
        include_clickers: true,
        exclude_clickers: true,
      }),
    });
    check("returns 400", s3R.status === 400);

    console.log("\n[4] GET list — default sort is asc by stage_number");
    const listR = await apiFetch(`/api/campaigns/${campaign.id}/stages`);
    const list = (await listR.json()) as {
      data: { id: number; stage_number: number }[];
    };
    check(
      "two stages present",
      list.data.length === 2 &&
        list.data[0].stage_number === 1 &&
        list.data[1].stage_number === 2,
    );

    console.log("\n[5] PATCH stage 1 label → 200");
    const p1R = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${s1.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ label: "Day 1 push" }),
      },
    );
    check("returns 200", p1R.status === 200);

    console.log("\n[6] PATCH stage_number → silently dropped");
    const p2R = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${s1.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ stage_number: 99, label: "Still day 1" }),
      },
    );
    check("returns 200 (stage_number ignored)", p2R.status === 200);
    const checkR = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${s1.id}`,
    );
    const checkBody = (await checkR.json()) as { stage_number: number };
    check(
      "stage_number unchanged at 1",
      checkBody.stage_number === 1,
      `got ${checkBody.stage_number}`,
    );

    console.log("\n[7] Stage 1: draft → pending → sent → success");
    const ss1R = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${s1.id}/status`,
      {
        method: "POST",
        body: JSON.stringify({ status: "pending" }),
      },
    );
    check("pending: 200", ss1R.status === 200);
    const ss2R = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${s1.id}/status`,
      {
        method: "POST",
        body: JSON.stringify({ status: "sent" }),
      },
    );
    check("sent: 200", ss2R.status === 200);
    const sentRow = (await ss2R.json()) as { sent_at: string | null };
    check(
      "sent_at populated on entering 'sent'",
      sentRow.sent_at !== null,
    );
    const ss3R = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${s1.id}/status`,
      {
        method: "POST",
        body: JSON.stringify({ status: "success" }),
      },
    );
    check("success: 200", ss3R.status === 200);

    console.log("\n[8] Stage 2: draft → cancelled → 200; cancelled → sent → 409");
    const ss4R = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${s2.id}/status`,
      {
        method: "POST",
        body: JSON.stringify({ status: "cancelled" }),
      },
    );
    check("cancelled: 200", ss4R.status === 200);
    const ss5R = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${s2.id}/status`,
      {
        method: "POST",
        body: JSON.stringify({ status: "sent" }),
      },
    );
    check("cancelled → sent: 409 (terminal)", ss5R.status === 409);
  } finally {
    console.log("\nCleanup");
    try {
      for (const cid of createdCampaignIds) {
        // Stages cascade with the campaign.
        await db.delete(campaigns).where(eq(campaigns.id, cid));
      }
      for (const cid of createdCreativeIds) {
        await db.delete(creatives).where(eq(creatives.id, cid));
      }
      if (insertedPhones.length > 0) {
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
