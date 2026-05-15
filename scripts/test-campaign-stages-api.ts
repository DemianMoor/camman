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
  campaigns,
  clickers,
  contacts,
  creatives,
  offers,
  opt_outs,
  segment_contacts,
  contact_groups,
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
  const createdNetworkIds: number[] = [];
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

    // Networks are now required on offers.
    const netR = await apiFetch("/api/networks", {
      method: "POST",
      body: JSON.stringify({
        name: `Stage Test Network ${unique}`,
        network_id: `STG-N-${unique}`,
      }),
    });
    check("seed: network creation returns 201", netR.status === 201);
    const network = (await netR.json()) as { id: number };
    createdNetworkIds.push(network.id);

    const offerR = await apiFetch("/api/offers", {
      method: "POST",
      body: JSON.stringify({
        name: "Stage Test Offer",
        offer_id: `STG-O-${unique}`,
        network_id: network.id,
        payout_model: "cpa",
        payout_cpa: 10,
      }),
    });
    check("seed: offer creation returns 201", offerR.status === 201);
    const offer = (await offerR.json()) as { id: number };
    createdOfferIds.push(offer.id);

    const grpR = await apiFetch("/api/contact-groups", {
      method: "POST",
      body: JSON.stringify({
        name: "Stage Group",
        contact_group_id: `STG-G-${unique}`,
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
        offer_ids: [offer.id],
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
    const s1 = (await s1R.json()) as {
      id: number;
      stage_number: number;
      tracking_id: string | null;
    };
    check("stage_number = 1 (trigger assigned)", s1.stage_number === 1);
    // Stage tracking_id format: `<campaign_tracking_id>_s<stage_number>_c<creative_id>`
    check(
      "stage tracking_id matches expected format with stage_number and creative_id",
      typeof s1.tracking_id === "string" &&
        new RegExp(`_s${s1.stage_number}_c${cre.id}$`).test(
          s1.tracking_id ?? "",
        ),
      `got ${JSON.stringify(s1.tracking_id)}`,
    );

    console.log("\n[2] POST stage 2");
    const s2R = await apiFetch(`/api/campaigns/${campaign.id}/stages`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    check("returns 201", s2R.status === 201);
    const s2 = (await s2R.json()) as {
      id: number;
      stage_number: number;
      tracking_id: string | null;
    };
    check("stage_number = 2", s2.stage_number === 2);
    check(
      "stage 2 tracking_id is null (no creative_id)",
      s2.tracking_id === null,
      `got ${JSON.stringify(s2.tracking_id)}`,
    );

    console.log("\n[1b] PATCH tracking_id on stage → 400 TRACKING_ID_IMMUTABLE");
    const immStageR = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${s1.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ tracking_id: "hacked" }),
      },
    );
    check("returns 400", immStageR.status === 400);
    const immStageBody = (await immStageR.json()) as { code?: string };
    check(
      "error code = TRACKING_ID_IMMUTABLE",
      immStageBody.code === "tracking_id_immutable",
      `got code=${immStageBody.code}`,
    );

    console.log("\n[1c] PATCH creative_id does NOT regenerate tracking_id");
    // Create a second creative on the same offer and switch the stage to it.
    const cre2R = await apiFetch("/api/creatives", {
      method: "POST",
      body: JSON.stringify({
        offer_ids: [offer.id],
        text: "Stage test SMS body — alt",
      }),
    });
    const cre2 = (await cre2R.json()) as { id: number };
    createdCreativeIds.push(cre2.id);
    const switchR = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${s1.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ creative_id: cre2.id }),
      },
    );
    const switched = (await switchR.json()) as { tracking_id: string | null };
    check(
      "tracking_id preserved (still references original creative_id)",
      switched.tracking_id === s1.tracking_id,
      `was ${s1.tracking_id}, now ${switched.tracking_id}`,
    );

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

    console.log("\n[9] Stage phone export — against the [7b] preview campaign");
    // Reuse the previewCamp built in [7b]: 30 pool members (20 no-status +
    // 10 clickers), 3 post-snapshot opt-outs (2 no-status, 1 clicker).

    // Stage A: include_no_status=true, exclude_clickers=false, include_clickers=false
    //   eligible = 20 no-status - 2 opted-out = 18
    const stageAR = await apiFetch(
      `/api/campaigns/${previewCamp.id}/stages`,
      {
        method: "POST",
        body: JSON.stringify({
          include_no_status: true,
          include_clickers: false,
          exclude_clickers: false,
        }),
      },
    );
    check(
      "preview stage A (no-status only) creates: 201",
      stageAR.status === 201,
    );
    const stageA = (await stageAR.json()) as {
      id: number;
      stage_number: number;
    };

    // [9.1] audience-count endpoint matches expectation + breakdown shape
    const acR = await apiFetch(
      `/api/campaigns/${previewCamp.id}/stages/${stageA.id}/audience-count`,
    );
    check("audience-count: 200", acR.status === 200);
    const ac = (await acR.json()) as {
      count: number;
      breakdown: {
        no_status: number;
        clickers: number;
        excluded_for_optout: number;
      };
      pool_size: number;
    };
    check("audience-count.count = 18 (20 - 2 opt-out)", ac.count === 18, `got ${ac.count}`);
    check(
      "audience-count breakdown.no_status = 18",
      ac.breakdown.no_status === 18,
    );
    check(
      "audience-count breakdown.clickers = 9",
      ac.breakdown.clickers === 9,
    );
    check(
      "audience-count breakdown.excluded_for_optout = 3",
      ac.breakdown.excluded_for_optout === 3,
    );

    // [9.2] CSV export — headers
    const exportAR = await apiFetch(
      `/api/campaigns/${previewCamp.id}/stages/${stageA.id}/export-phones`,
    );
    check("export-phones: 200", exportAR.status === 200);
    check(
      "Content-Type starts with text/csv",
      (exportAR.headers.get("content-type") ?? "").startsWith("text/csv"),
      `got ${exportAR.headers.get("content-type")}`,
    );
    const cd = exportAR.headers.get("content-disposition") ?? "";
    check(
      "Content-Disposition contains attachment",
      cd.toLowerCase().includes("attachment"),
      `got ${cd}`,
    );
    check(
      "Filename matches campaign-<slug>-stage-N-phones-YYYY-MM-DD-HHmmss.csv",
      /filename="campaign-.+-stage-\d+-phones-\d{4}-\d{2}-\d{2}-\d{6}\.csv"/.test(
        cd,
      ),
      `got ${cd}`,
    );

    // [9.3] CSV body: row count + 10-digit format
    const exportABody = await exportAR.text();
    const exportALines = exportABody.split("\n").filter((l) => l.length > 0);
    // Header is line 0; the rest are data rows.
    check(
      "data row count matches audience-count",
      exportALines.length - 1 === ac.count,
      `expected ${ac.count} data rows, got ${exportALines.length - 1}`,
    );
    check(
      "all phone numbers are 10 digits",
      exportALines
        .slice(1)
        .every((line) => /^\d{10}$/.test(line.trim())),
    );

    // [9.4] limit param
    const exportLimitR = await apiFetch(
      `/api/campaigns/${previewCamp.id}/stages/${stageA.id}/export-phones?limit=5`,
    );
    check("export with limit=5: 200", exportLimitR.status === 200);
    const limitedLines = (await exportLimitR.text())
      .split("\n")
      .filter((l) => l.length > 0);
    check(
      "limit=5 returns exactly 5 data rows",
      limitedLines.length - 1 === 5,
      `got ${limitedLines.length - 1} data rows`,
    );

    // [9.5] empty-audience stage still returns a valid CSV with just the header.
    const emptyStageR = await apiFetch(
      `/api/campaigns/${previewCamp.id}/stages`,
      {
        method: "POST",
        body: JSON.stringify({
          include_no_status: false,
          include_clickers: false,
          exclude_clickers: false,
        }),
      },
    );
    check("empty-audience stage creates: 201", emptyStageR.status === 201);
    const emptyStage = (await emptyStageR.json()) as { id: number };
    const emptyExportR = await apiFetch(
      `/api/campaigns/${previewCamp.id}/stages/${emptyStage.id}/export-phones`,
    );
    check("empty-audience export: 200", emptyExportR.status === 200);
    const emptyExportBody = await emptyExportR.text();
    const emptyExportLines = emptyExportBody
      .split("\n")
      .filter((l) => l.length > 0);
    check(
      "empty-audience CSV has only the header line",
      emptyExportLines.length === 1,
      `got ${emptyExportLines.length} non-empty lines`,
    );
    check(
      "empty-audience filename still well-formed",
      /filename="campaign-.+-stage-\d+-phones-\d{4}-\d{2}-\d{2}-\d{6}\.csv"/.test(
        emptyExportR.headers.get("content-disposition") ?? "",
      ),
    );

    // [9.6] deterministic ordering on re-export
    const exportA2R = await apiFetch(
      `/api/campaigns/${previewCamp.id}/stages/${stageA.id}/export-phones`,
    );
    const exportA2Body = await exportA2R.text();
    check("re-export: 200", exportA2R.status === 200);
    check(
      "re-export rows are identical to first export",
      exportABody === exportA2Body,
    );

    // [9.7] stages list now includes audience_count per row
    const stagesListR = await apiFetch(
      `/api/campaigns/${previewCamp.id}/stages?pageSize=50`,
    );
    const stagesList = (await stagesListR.json()) as {
      data: { id: number; audience_count: number }[];
    };
    const stageAInList = stagesList.data.find((s) => s.id === stageA.id);
    const emptyInList = stagesList.data.find((s) => s.id === emptyStage.id);
    check(
      "stages list includes audience_count = 18 for stage A",
      stageAInList?.audience_count === 18,
      `got ${stageAInList?.audience_count}`,
    );
    check(
      "stages list includes audience_count = 0 for empty stage",
      emptyInList?.audience_count === 0,
      `got ${emptyInList?.audience_count}`,
    );

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
        await db.delete(contact_groups).where(eq(contact_groups.id, gid));
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
