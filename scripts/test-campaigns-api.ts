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
  campaign_audience_pool,
  campaigns,
  contacts,
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
  const insertedPhones: string[] = [];
  const createdBrandIds: number[] = [];
  const createdOfferIds: number[] = [];
  const createdNetworkIds: number[] = [];
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

    // Network is now required on offers.
    const networkR = await apiFetch("/api/networks", {
      method: "POST",
      body: JSON.stringify({
        name: `Campaign Probe Network ${unique}`,
        network_id: `CMP-NET-${unique}`,
      }),
    });
    check("seed: network creation returns 201", networkR.status === 201);
    const network = (await networkR.json()) as { id: number };
    createdNetworkIds.push(network.id);

    const offerR = await apiFetch("/api/offers", {
      method: "POST",
      body: JSON.stringify({
        name: "Campaign Probe Offer",
        offer_id: `CMP-OFFER-${unique}`,
        network_id: network.id,
        payout_model: "cpa",
        payout_cpa: 10,
        // ⚠️ REQUIRED since migration 0194 (#247): offerCreateSchema has
        // `brand_ids: …min(1, "Select at least one brand")`. Without it this
        // seed 400s, and because every later step needs the offer, the whole
        // suite cascades — campaign create 400, tracking ids NaN, teardown
        // deleting `undefined`. The suite looked broken in six places for one
        // missing field. Not a product defect: the create form has required a
        // brand since 0194 too.
        brand_ids: [brand.id],
      }),
    });
    check("seed: offer creation returns 201", offerR.status === 201);
    const offer = (await offerR.json()) as { id: number };
    createdOfferIds.push(offer.id);

    // Contact group used as a smoke check that the renamed API works.
    const grpR = await apiFetch("/api/contact-groups", {
      method: "POST",
      body: JSON.stringify({
        name: "Campaign Probe Group",
        contact_group_id: `CMP-GRP-${unique}`,
      }),
    });
    check("seed: contact-group creation returns 201", grpR.status === 201);
    const grp = (await grpR.json()) as { id: number };
    createdGroupIds.push(grp.id);

    const segR = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({
        name: "Campaign Probe Segment",
        segment_id: `CMP-SEG-${unique}`,
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

    // ⚠️ PUT THE SAME CONTACTS IN THE CONTACT GROUP. The campaign below
    // selects a segment AND a group, and since 2026-06-10 those dimensions
    // INTERSECT rather than UNION (CLAUDE.md §10b). Contacts in the segment
    // alone intersect to NOBODY: the create route refuses with
    // `empty_audience`, and every later assertion fails on a campaign that
    // was never made. The test predates the intersect change.
    //
    // Through bulk-apply-groups, NOT an `assign_to_group_ids` on the segment
    // upload above: that field exists on the contacts / opt-outs / opt-ins /
    // clickers uploads only, and the segment upload’s schema strips it without
    // an error -- which is how the first attempt at this fix did nothing.
    const seededIds = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(inArray(contacts.phone_number, phones));
    const grpApplyR = await apiFetch("/api/contacts/bulk-apply-groups", {
      method: "POST",
      body: JSON.stringify({
        contact_ids: seededIds.map((r) => r.id),
        group_ids: [grp.id],
      }),
    });
    check(
      "seed: the same 100 contacts added to the contact group",
      grpApplyR.status === 200 && seededIds.length === 100,
      `status ${grpApplyR.status}, ${seededIds.length} ids`,
    );

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
        audience_contact_group_ids: [grp.id],
        audience_filters: {
          include_no_status: true,
          include_not_clicked: true,
        },
        save_as_draft: false,
      }),
    });
    // Read the body ONCE and show it when the status is wrong. Without this a
    // failure reads "got 400" and says nothing about which field the server
    // rejected -- which is how a single missing seed field looked like six
    // unrelated broken assertions.
    const c1Text = await c1R.text();
    check(
      "returns 201",
      c1R.status === 201,
      c1R.status === 201 ? "" : `got ${c1R.status} — ${c1Text.slice(0, 220)}`,
    );
    const c1 = JSON.parse(c1Text || "{}") as {
      id: number;
      status: string;
      audience_snapshot_count: number;
      slug: string;
      tracking_id: string | null;
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
    check(
      "tracking_id is generated on POST when brand+offer set",
      typeof c1.tracking_id === "string" &&
        new RegExp(`^${brand.id}_${offer.id}_\\d{6}_\\d+$`).test(
          c1.tracking_id ?? "",
        ),
      `got ${JSON.stringify(c1.tracking_id)}`,
    );

    // Same brand+offer, same day → second tracking_id gets the next
    // sequence number. We hit the launch path again with a different
    // name so the slug is unique.
    const c1bR = await apiFetch("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: `Test Campaign ${unique} B`,
        // ⚠️ exclude_in_use_contacts defaults to TRUE (§10b). The first campaign
        // is ACTIVE and holds these same 95 contacts, so with the default this
        // second campaign would correctly select nobody (`empty_audience`,
        // in_use_in_other_campaigns = 95). What is under test here is not the
        // in-use exclusion, so it is switched off EXPLICITLY rather than by
        // relying on an old default.
        exclude_in_use_contacts: false,
        brand_id: brand.id,
        offer_id: offer.id,
        audience_segment_ids: [seg.id],
        audience_contact_group_ids: [grp.id],
        audience_filters: { include_no_status: true, include_not_clicked: true },
        save_as_draft: false,
      }),
    });
    const c1bText = await c1bR.text();
    if (c1bR.status !== 201) console.log(`    ↳ second create: ${c1bR.status} ${c1bText.slice(0, 220)}`);
    const c1b = JSON.parse(c1bText || "{}") as {
      id: number;
      tracking_id: string | null;
    };
    createdCampaignIds.push(c1b.id);
    const seq1 = Number(c1.tracking_id?.split("_").pop());
    const seq2 = Number(c1b.tracking_id?.split("_").pop());
    check(
      "second campaign same brand+offer+day gets next sequence number",
      Number.isInteger(seq1) && Number.isInteger(seq2) && seq2 === seq1 + 1,
      `seq1=${seq1}, seq2=${seq2}`,
    );

    // PATCH attempting to mutate tracking_id is rejected with
    // TRACKING_ID_IMMUTABLE code.
    const immR = await apiFetch(`/api/campaigns/${c1.id}`, {
      method: "PATCH",
      body: JSON.stringify({ tracking_id: "hacked" }),
    });
    check(
      "PATCH tracking_id returns 400",
      immR.status === 400,
      `got ${immR.status}`,
    );
    const immBody = (await immR.json()) as { code?: string };
    check(
      "PATCH tracking_id error code = TRACKING_ID_IMMUTABLE",
      immBody.code === "tracking_id_immutable",
      `got code=${immBody.code}`,
    );

    // Tracking ID is preserved across edits to brand_id (historical
    // reference stays). For this assertion we leave brand_id alone but
    // change name, then re-fetch and confirm tracking_id is unchanged.
    const renameR = await apiFetch(`/api/campaigns/${c1.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: `Renamed ${unique}` }),
    });
    check("PATCH name returns 200", renameR.status === 200);
    const renameBody = (await renameR.json()) as { tracking_id: string | null };
    check(
      "tracking_id unchanged after PATCH name",
      renameBody.tracking_id === c1.tracking_id,
      `was ${c1.tracking_id}, now ${renameBody.tracking_id}`,
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
      "\n[2] POST create with save_as_draft=true and ZERO other fields",
    );
    // Drafts are scratchpads: no required fields. The API auto-generates
    // a name from the current time and skips the audience snapshot.
    const c2R = await apiFetch("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({ save_as_draft: true }),
    });
    check("returns 201", c2R.status === 201);
    const c2 = (await c2R.json()) as {
      id: number;
      status: string;
      name: string | null;
      brand_id: number | null;
      offer_id: number | null;
      audience_snapshot_count: number;
      tracking_id: string | null;
    };
    createdCampaignIds.push(c2.id);
    check("status = 'draft'", c2.status === "draft");
    check(
      "name matches auto-generated pattern",
      c2.name !== null &&
        /^Draft - \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(c2.name),
      `got ${JSON.stringify(c2.name)}`,
    );
    check("brand_id is null", c2.brand_id === null);
    check("offer_id is null", c2.offer_id === null);
    check(
      "audience_snapshot_count = 0",
      c2.audience_snapshot_count === 0,
    );
    check(
      "tracking_id is null for empty draft",
      c2.tracking_id === null,
      `got ${JSON.stringify(c2.tracking_id)}`,
    );
    const c2Pool = await db
      .select({ contact_id: campaign_audience_pool.contact_id })
      .from(campaign_audience_pool)
      .where(eq(campaign_audience_pool.campaign_id, c2.id));
    check(
      "campaign_audience_pool has 0 rows for the empty draft",
      c2Pool.length === 0,
    );

    console.log(
      "\n[2b] POST create with save_as_draft=false and no brand_id → 400",
    );
    // The launch path still enforces brand + offer + name + ≥1 segment.
    const c2bR = await apiFetch("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: `Bad Launch ${unique}`,
        save_as_draft: false,
      }),
    });
    check(
      "launch without brand_id returns 400",
      c2bR.status === 400,
      `got ${c2bR.status}`,
    );

    console.log(
      "\n[2c] Create empty draft → PATCH fields → activate (snapshot at activation)",
    );
    const c2cR = await apiFetch("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({ save_as_draft: true }),
    });
    const c2c = (await c2cR.json()) as { id: number };
    createdCampaignIds.push(c2c.id);
    // Fill in launch-required fields via PATCH (draft path allows audience
    // changes).
    const c2cPatchR = await apiFetch(`/api/campaigns/${c2c.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: `Filled Draft ${unique}`,
        brand_id: brand.id,
        offer_id: offer.id,
        audience_segment_ids: [seg.id],
        audience_contact_group_ids: [grp.id],
        // ⚠️ exclude_in_use_contacts defaults to TRUE (§10b). The first campaign
        // is ACTIVE and holds these same 95 contacts, so with the default this
        // draft would correctly select nobody (`empty_audience`,
        // in_use_in_other_campaigns = 95). What is under test here is not the
        // in-use exclusion, so it is switched off EXPLICITLY rather than by
        // relying on an old default.
        exclude_in_use_contacts: false,
        audience_filters: {
          include_no_status: true,
          include_not_clicked: true,
        },
      }),
    });
    check("PATCH on draft returns 200", c2cPatchR.status === 200);
    const c2cPatched = (await c2cPatchR.json()) as { tracking_id: string | null };
    check(
      "tracking_id is generated by PATCH when draft gets brand+offer",
      typeof c2cPatched.tracking_id === "string" &&
        new RegExp(`^${brand.id}_${offer.id}_\\d{6}_\\d+$`).test(
          c2cPatched.tracking_id ?? "",
        ),
      `got ${JSON.stringify(c2cPatched.tracking_id)}`,
    );
    // Activate.
    const c2cActR = await apiFetch(`/api/campaigns/${c2c.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "active" }),
    });
    check(
      "draft → active returns 200",
      c2cActR.status === 200,
      c2cActR.status === 200 ? "" : `got ${c2cActR.status} — ${(await c2cActR.clone().text()).slice(0, 220)}`,
    );
    const c2cActivated = (await c2cActR.json()) as {
      status: string;
      audience_snapshot_count: number;
    };
    check("status flipped to 'active'", c2cActivated.status === "active");
    check(
      "audience_snapshot_count populated at activation (= 95)",
      c2cActivated.audience_snapshot_count === 95,
      `got ${c2cActivated.audience_snapshot_count}`,
    );
    const c2cPool = await db
      .select({ contact_id: campaign_audience_pool.contact_id })
      .from(campaign_audience_pool)
      .where(eq(campaign_audience_pool.campaign_id, c2c.id));
    check(
      "campaign_audience_pool now has 95 rows for the activated campaign",
      c2cPool.length === 95,
      `got ${c2cPool.length}`,
    );

    console.log(
      "\n[2d] Activate an empty draft without filling fields → 400 incomplete_draft",
    );
    const c2dR = await apiFetch("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({ save_as_draft: true }),
    });
    const c2d = (await c2dR.json()) as { id: number };
    createdCampaignIds.push(c2d.id);
    const c2dActR = await apiFetch(`/api/campaigns/${c2d.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "active" }),
    });
    check(
      "empty draft → active returns 400",
      c2dActR.status === 400,
      `got ${c2dActR.status}`,
    );
    const c2dBody = await c2dActR.json();
    check(
      "details.reason = 'incomplete_draft'",
      c2dBody.details?.reason === "incomplete_draft",
    );
    const missing = c2dBody.details?.missing ?? [];
    check(
      "details.missing includes name, brand_id, offer_id, audience_contact_group_ids",
      Array.isArray(missing) &&
        missing.includes("brand_id") &&
        missing.includes("offer_id") &&
        missing.includes("audience_contact_group_ids"),
      `got ${JSON.stringify(missing)}`,
    );

    console.log(
      "\n[2e] Activate a draft whose audience is all opt-outs → 400 empty_audience",
    );
    // Seed: a fresh segment with only opt-out contacts.
    const optOutSegR = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({
        name: `OptOut-Only Segment ${unique}`,
        segment_id: `OO-ONLY-${unique}`,
      }),
    });
    check(
      "seed: opt-out-only segment creation returns 201",
      optOutSegR.status === 201,
    );
    const optOutSeg = (await optOutSegR.json()) as { id: number };
    createdSegmentIds.push(optOutSeg.id);
    // 10-digit US format: +1 + area + 7 digits. The seed timestamp gives
    // us enough variation per run.
    // 10-digit national format; pick a base disjoint from the main fixture range.
    const ooBaseN = (Number(String(unique).slice(-6)) % 9_000) + 1_000;
    const ooOnlyPhones = [
      `+1415555${String(ooBaseN).padStart(4, "0")}`,
      `+1415555${String(ooBaseN + 1).padStart(4, "0")}`,
      `+1415555${String(ooBaseN + 2).padStart(4, "0")}`,
    ];
    insertedPhones.push(...ooOnlyPhones);
    const ooUploadR = await apiFetch(
      `/api/segments/${optOutSeg.id}/contacts/upload`,
      {
        method: "POST",
        body: JSON.stringify({ phones: ooOnlyPhones.join("\n") }),
      },
    );
    const ooUploadBody = (await ooUploadR.json()) as { inserted: number };
    check(
      "seed: opt-out-only contacts uploaded (3)",
      ooUploadBody.inserted === 3,
      `inserted=${ooUploadBody.inserted}`,
    );
    // Mark all three phones as opt-outs at the org level so the snapshot
    // qualifier filters them out.
    const ooContactRows = await db
      .select({ id: contacts.id, phone_number: contacts.phone_number })
      .from(contacts)
      .where(inArray(contacts.phone_number, ooOnlyPhones));
    await db.insert(opt_outs).values(
      ooContactRows.map((c) => ({
        org_id: orgId!,
        contact_id: c.id,
        phone_number: c.phone_number,
        source: "test",
      })),
    );
    // Now build the draft pointed at that opt-out-only segment and try to
    // activate.
    const c2eR = await apiFetch("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({ save_as_draft: true }),
    });
    const c2e = (await c2eR.json()) as { id: number };
    createdCampaignIds.push(c2e.id);
    await apiFetch(`/api/campaigns/${c2e.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: `Empty Audience Draft ${unique}`,
        brand_id: brand.id,
        offer_id: offer.id,
        audience_segment_ids: [optOutSeg.id],
        // Group is required on launch even though the activation will
        // ultimately fail on empty_audience — without it, activation
        // would fail earlier on missing audience_contact_group_ids.
        audience_contact_group_ids: [grp.id],
        audience_filters: {
          include_no_status: true,
          include_not_clicked: true,
        },
      }),
    });
    const c2eActR = await apiFetch(`/api/campaigns/${c2e.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "active" }),
    });
    check(
      "opt-outs-only segment → active returns 400",
      c2eActR.status === 400,
      `got ${c2eActR.status}`,
    );
    const c2eBody = await c2eActR.json();
    check(
      "details.reason = 'empty_audience'",
      c2eBody.details?.reason === "empty_audience",
      `got ${JSON.stringify(c2eBody.details)}`,
    );

    console.log(
      "\n[2f] Draft create with EXPLICIT null for name/brand_id/offer_id → 201",
    );
    // Browsers JSON.stringify a `null` field as `"field": null` (not
    // omitted). Validators must accept null on optional fields or the form
    // path breaks even though the API-test path (which omits keys) works.
    // This regression-tests that distinction.
    const c2fR = await apiFetch("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: null,
        human_id: null,
        notes: null,
        brand_id: null,
        offer_id: null,
        routing_type_id: null,
        traffic_type_id: null,
        assigned_to_user_id: null,
        start_date: null,
        end_date: null,
        save_as_draft: true,
      }),
    });
    check(
      "draft with explicit nulls returns 201",
      c2fR.status === 201,
      `got ${c2fR.status}`,
    );
    const c2f = (await c2fR.json()) as {
      id: number;
      status: string;
      name: string | null;
      brand_id: number | null;
    };
    createdCampaignIds.push(c2f.id);
    check("status = 'draft'", c2f.status === "draft");
    check(
      "auto-generated name applied despite explicit null",
      c2f.name !== null &&
        /^Draft - \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(c2f.name),
      `got ${JSON.stringify(c2f.name)}`,
    );
    check("brand_id is null", c2f.brand_id === null);

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
    // ⚠️ RETIRED EXPECTATION: this used to assert 409. Reactivating a completed
    // campaign became a deliberate feature in 7f06b78d (2026-08-19, card
    // 869ekxp0b: "activate campaign after it was marked as completed");
    // TRANSITIONS now reads `completed: new Set(["active"]) // can be
    // reactivated`. The assertion follows the product.
    check(
      "completed → active: 200 (reactivation, 869ekxp0b)",
      s4R.status === 200,
      s4R.status === 200 ? "" : `got ${s4R.status} — ${(await s4R.clone().text()).slice(0, 220)}`,
    );
    // …and the coverage the old line gave — an INVALID transition is refused —
    // is kept with one TRANSITIONS still forbids: active → draft.
    const s5R = await apiFetch(`/api/campaigns/${c1.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "draft" }),
    });
    const s5Body = (await s5R.json().catch(() => ({}))) as {
      details?: { reason?: string };
    };
    check(
      "active → draft: 409 invalid_transition",
      s5R.status === 409 && s5Body.details?.reason === "invalid_transition",
      `got ${s5R.status} ${JSON.stringify(s5Body).slice(0, 160)}`,
    );
    // Return the campaign to completed so it stops holding the 95 contacts as
    // "in use" for the preview check in [8].
    const s6R = await apiFetch(`/api/campaigns/${c1.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "completed" }),
    });
    check("active → completed again: 200", s6R.status === 200);

    console.log("\n[8] POST audience-preview (no DB write)");
    const previewR = await apiFetch("/api/campaigns/audience-preview", {
      method: "POST",
      body: JSON.stringify({
        audience_segment_ids: [seg.id],
        audience_filters: {
          include_no_status: true,
          include_not_clicked: true,
        },
        // Same flag the snapshots above were taken with. The route defaults it
        // to TRUE, and the [2c] campaign is ACTIVE holding these 95 contacts, so
        // the default would report 0 (in_use_in_other_campaigns = 95) -- correct
        // behaviour, but not what "matches snapshot logic" is checking.
        exclude_in_use_contacts: false,
      }),
    });
    check("returns 200", previewR.status === 200);
    const preview = (await previewR.json()) as { count: number };
    check(
      "preview count = 95 (matches snapshot logic)",
      preview.count === 95,
      `got ${preview.count} — ${JSON.stringify(preview).slice(0, 260)}`,
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
      // ⚠️ ONLY IDS THAT WERE ACTUALLY ASSIGNED. When a create fails the suite
      // still pushes `created.id`, which is `undefined`, and a delete bound to
      // an undefined parameter killed the connection (ECONNRESET) in one run
      // and HUNG past a 5-minute cap in the next -- the "suite hang" was this,
      // not a slow query: deleting all 100 seeded contacts takes 236 ms on
      // preview. A failed seed must surface as its failed assertion, not as
      // a hang in teardown that hides it.
      const real = <T,>(xs: (T | undefined | null)[]): T[] =>
        xs.filter((x): x is T => x != null);
      for (const cid of real(createdCampaignIds)) {
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
      for (const sid of real(createdSegmentIds)) {
        await db.delete(segments).where(eq(segments.id, sid));
      }
      for (const gid of real(createdGroupIds)) {
        await db.delete(contact_groups).where(eq(contact_groups.id, gid));
      }
      for (const oid of real(createdOfferIds)) {
        await db.delete(offers).where(eq(offers.id, oid));
      }
      for (const nid of real(createdNetworkIds)) {
        await db.delete(affiliate_networks).where(eq(affiliate_networks.id, nid));
      }
      for (const bid of real(createdBrandIds)) {
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
