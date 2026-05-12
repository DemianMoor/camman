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
  clickers,
  contacts,
  creatives,
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

    console.log(
      "\n[7b] Stage audience preview — filter combinations on a separate campaign",
    );
    // Build a fresh campaign with a controllable mix: 20 no-status + 10
    // clickers in its frozen pool, then opt out 3 (2 no-status + 1 clicker).
    // This lets us verify the include/exclude combinations precisely.
    const previewUnique = String(Date.now()).slice(-6).padStart(6, "0");
    // 30 phones, valid US E.164 (10 digits after +1). Format:
    // +1 510 7 {4 digits from run} {2 digits from i} → unique per run + i.
    // The first 10 will become clickers (before campaign creation).
    const previewPhones: string[] = [];
    for (let i = 0; i < 30; i++) {
      previewPhones.push(
        `+15107${previewUnique.slice(0, 4)}${String(i).padStart(2, "0")}`,
      );
    }
    // Sanity-check uniqueness — previewUnique gives us 30 distinct phones
    // only if i never collides with another test's phones.
    insertedPhones.push(...previewPhones);

    const previewSegR = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({
        name: `Preview Test Segment ${previewUnique}`,
        segment_id: `PREV-SEG-${previewUnique}`,
      }),
    });
    check(
      "seed: preview segment creation returns 201",
      previewSegR.status === 201,
    );
    const previewSeg = (await previewSegR.json()) as { id: number };
    createdSegmentIds.push(previewSeg.id);

    const previewUploadR = await apiFetch(
      `/api/segments/${previewSeg.id}/contacts/upload`,
      {
        method: "POST",
        body: JSON.stringify({ phones: previewPhones.join("\n") }),
      },
    );
    const previewUploadBody = (await previewUploadR.json()) as {
      inserted: number;
    };
    check(
      "seed: 30 preview contacts uploaded",
      previewUploadBody.inserted === 30,
      `inserted=${previewUploadBody.inserted}`,
    );

    // Resolve contact_ids in upload order so we know which 10 to make clickers.
    const previewContactRows = await db
      .select({ id: contacts.id, phone_number: contacts.phone_number })
      .from(contacts)
      .where(inArray(contacts.phone_number, previewPhones));
    // Build an index keyed by phone_number for deterministic ordering.
    const byPhone = new Map(
      previewContactRows.map((r) => [r.phone_number, r.id]),
    );
    const clickerContactIds = previewPhones
      .slice(0, 10)
      .map((p) => byPhone.get(p)!);
    const noStatusContactIds = previewPhones
      .slice(10)
      .map((p) => byPhone.get(p)!);

    // Org id for direct Drizzle inserts comes from the seed brand.
    const probeOrgRow = await db
      .select({ org_id: brands.org_id })
      .from(brands)
      .where(eq(brands.id, brand.id))
      .limit(1);
    const orgId = probeOrgRow[0]!.org_id;

    // Mark 10 contacts as clickers (BEFORE creating the campaign so the
    // snapshot captures was_clicker_at_snapshot=true for them).
    await db.insert(clickers).values(
      clickerContactIds.map((cid) => ({
        org_id: orgId,
        contact_id: cid,
        phone_number: previewContactRows.find((r) => r.id === cid)!
          .phone_number,
        brand_id: brand.id,
        source: "test",
      })),
    );

    // Now create the campaign — its pool will have 10 was_clicker + 20
    // was_no_status. Filters must include BOTH categories so the snapshot
    // pulls everyone in.
    const previewCampR = await apiFetch("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: `Preview Test Campaign ${previewUnique}`,
        brand_id: brand.id,
        offer_id: offer.id,
        audience_segment_ids: [previewSeg.id],
        audience_filters: {
          include_no_status: true,
          include_clickers: true,
          include_not_clicked: false,
        },
        save_as_draft: false,
      }),
    });
    check(
      "seed: preview campaign launches",
      previewCampR.status === 201,
      `got ${previewCampR.status}`,
    );
    const previewCamp = (await previewCampR.json()) as {
      id: number;
      audience_snapshot_count: number;
    };
    createdCampaignIds.push(previewCamp.id);
    check(
      "preview campaign pool = 30",
      previewCamp.audience_snapshot_count === 30,
      `got ${previewCamp.audience_snapshot_count}`,
    );

    // Add 3 opt-outs AFTER snapshot: 2 no-status + 1 clicker.
    const optOutIds = [
      ...noStatusContactIds.slice(0, 2),
      clickerContactIds[0],
    ];
    await db.insert(opt_outs).values(
      optOutIds.map((cid) => ({
        org_id: orgId,
        contact_id: cid,
        phone_number: previewContactRows.find((r) => r.id === cid)!
          .phone_number,
        source: "test",
      })),
    );

    type PreviewResp = {
      count: number;
      breakdown: {
        no_status: number;
        clickers: number;
        excluded_for_optout: number;
      };
      pool_size: number;
    };
    async function preview(filters: {
      include_no_status: boolean;
      include_clickers: boolean;
      exclude_clickers: boolean;
    }) {
      const r = await apiFetch(
        `/api/campaigns/${previewCamp.id}/stages/audience-preview`,
        { method: "POST", body: JSON.stringify(filters) },
      );
      return { status: r.status, body: (await r.json()) as PreviewResp };
    }

    // 20 no-status total, 2 of them opted out → 18 eligible.
    const p1 = await preview({
      include_no_status: true,
      include_clickers: false,
      exclude_clickers: false,
    });
    check("no-status-only count = 18", p1.body.count === 18, `got ${p1.body.count}`);
    check(
      "no-status-only breakdown.no_status = 18",
      p1.body.breakdown.no_status === 18,
    );
    check(
      "breakdown.excluded_for_optout = 3 (regardless of filter)",
      p1.body.breakdown.excluded_for_optout === 3,
    );

    // 10 clickers total, 1 opted out → 9 eligible.
    const p2 = await preview({
      include_no_status: false,
      include_clickers: true,
      exclude_clickers: false,
    });
    check("clickers-only count = 9", p2.body.count === 9, `got ${p2.body.count}`);
    check(
      "clickers-only breakdown.clickers = 9",
      p2.body.breakdown.clickers === 9,
    );

    // Both included → 18 + 9 = 27.
    const p3 = await preview({
      include_no_status: true,
      include_clickers: true,
      exclude_clickers: false,
    });
    check("both-included count = 27", p3.body.count === 27, `got ${p3.body.count}`);

    // include_no_status=true + exclude_clickers=true: no-status only,
    // clickers explicitly excluded → 18.
    const p4 = await preview({
      include_no_status: true,
      include_clickers: false,
      exclude_clickers: true,
    });
    check(
      "no-status + exclude_clickers count = 18",
      p4.body.count === 18,
      `got ${p4.body.count}`,
    );

    console.log(
      "\n[7c] scheduled_at: ISO datetime persists, PATCH-null clears, garbage rejected",
    );
    // POST a stage with an explicit ISO datetime (with offset). The server
    // stores it as TIMESTAMPTZ; the GET should round-trip the same instant.
    const scheduledIso = "2026-06-15T18:30:00.000Z";
    const stgSchedR = await apiFetch(`/api/campaigns/${campaign.id}/stages`, {
      method: "POST",
      body: JSON.stringify({ scheduled_at: scheduledIso }),
    });
    check("scheduled_at create: 201", stgSchedR.status === 201);
    const stgSched = (await stgSchedR.json()) as {
      id: number;
      scheduled_at: string | null;
    };
    check(
      "scheduled_at persists as same instant",
      stgSched.scheduled_at !== null &&
        new Date(stgSched.scheduled_at).getTime() ===
          new Date(scheduledIso).getTime(),
      `got ${stgSched.scheduled_at}`,
    );

    // Round-trip via GET to make sure it survives select.
    const stgSchedGetR = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${stgSched.id}`,
    );
    const stgSchedGet = (await stgSchedGetR.json()) as {
      scheduled_at: string | null;
    };
    check(
      "GET round-trip preserves scheduled_at",
      stgSchedGet.scheduled_at !== null &&
        new Date(stgSchedGet.scheduled_at).getTime() ===
          new Date(scheduledIso).getTime(),
    );

    // PATCH to null clears the value.
    const stgSchedNullR = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${stgSched.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ scheduled_at: null }),
      },
    );
    check("PATCH scheduled_at=null: 200", stgSchedNullR.status === 200);
    const stgSchedNullBody = (await stgSchedNullR.json()) as {
      scheduled_at: string | null;
    };
    check(
      "scheduled_at cleared to null",
      stgSchedNullBody.scheduled_at === null,
      `got ${stgSchedNullBody.scheduled_at}`,
    );

    // Validator must reject non-ISO strings (the old YYYY-MM-DD format
    // is no longer accepted).
    const stgSchedBadR = await apiFetch(`/api/campaigns/${campaign.id}/stages`, {
      method: "POST",
      body: JSON.stringify({ scheduled_at: "2026-06-15" }),
    });
    check(
      "non-ISO scheduled_at rejected with 400",
      stgSchedBadR.status === 400,
      `got ${stgSchedBadR.status}`,
    );

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
