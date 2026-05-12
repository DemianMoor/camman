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
  offers,
  opt_outs,
  result_import_mappings,
  segment_contacts,
  segments,
  sms_providers,
  stage_result_rows,
  stage_results_imports,
} from "../db/schema";

// Build a CSV string in memory. Header row + N rows; columns and per-row
// values are passed in as plain objects.
function buildCsv(headers: string[], rows: Record<string, string>[]): string {
  const escape = (v: string) =>
    /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => escape(r[h] ?? "")).join(","));
  }
  return lines.join("\n");
}

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
  const createdCampaignIds: number[] = [];
  const createdProviderIds: number[] = [];
  const createdMappingIds: number[] = [];
  const insertedPhones: string[] = [];

  try {
    // ============ Setup ============
    const brandR = await apiFetch("/api/brands", {
      method: "POST",
      body: JSON.stringify({ name: "RI Test Brand", brand_id: `RI-B-${unique}` }),
    });
    check("seed: brand 201", brandR.status === 201);
    const brand = (await brandR.json()) as { id: number };
    createdBrandIds.push(brand.id);

    const offerR = await apiFetch("/api/offers", {
      method: "POST",
      body: JSON.stringify({
        name: "RI Test Offer",
        offer_id: `RI-O-${unique}`,
        payout_model: "cpa",
        payout_cpa: 5,
      }),
    });
    check("seed: offer 201", offerR.status === 201);
    const offer = (await offerR.json()) as { id: number };
    createdOfferIds.push(offer.id);

    const provR = await apiFetch("/api/providers", {
      method: "POST",
      body: JSON.stringify({
        name: "RI Test Provider",
        sms_provider_id: `RI-PROV-${unique}`,
      }),
    });
    check("seed: provider 201", provR.status === 201);
    const provider = (await provR.json()) as { id: number };
    createdProviderIds.push(provider.id);

    const segR = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({
        name: `RI Segment ${unique}`,
        segment_id: `RI-SEG-${unique}`,
      }),
    });
    check("seed: segment 201", segR.status === 201);
    const segment = (await segR.json()) as { id: number };
    createdSegmentIds.push(segment.id);

    // 50 contacts in E.164. Unique per run via the `unique` epoch suffix.
    // Format: +1 510 7 NNNNNN — 10 digits after +1.
    const baseSuffix = String(unique).slice(-6);
    const phones: string[] = [];
    for (let i = 0; i < 50; i++) {
      const tail = (Number(baseSuffix) + i).toString().padStart(6, "0").slice(-6);
      phones.push(`+15107${tail}`);
    }
    insertedPhones.push(...phones);
    const uploadR = await apiFetch(
      `/api/segments/${segment.id}/contacts/upload`,
      {
        method: "POST",
        body: JSON.stringify({ phones: phones.join("\n") }),
      },
    );
    check("seed: 50 contacts uploaded", uploadR.status === 201);

    const campR = await apiFetch("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: `RI Test Campaign ${unique}`,
        brand_id: brand.id,
        offer_id: offer.id,
        audience_segment_ids: [segment.id],
        audience_filters: { include_no_status: true, include_not_clicked: true },
        save_as_draft: false,
      }),
    });
    check("seed: campaign launched", campR.status === 201);
    const campaign = (await campR.json()) as { id: number };
    createdCampaignIds.push(campaign.id);

    // Create one stage and put it in 'sent' status so it's a real send.
    const stage1R = await apiFetch(
      `/api/campaigns/${campaign.id}/stages`,
      {
        method: "POST",
        body: JSON.stringify({
          sms_provider_id: provider.id,
          include_no_status: true,
        }),
      },
    );
    check("seed: stage 201", stage1R.status === 201);
    const stage1 = (await stage1R.json()) as {
      id: number;
      stage_number: number;
    };

    // Take it draft → pending → sent so per-stage tests look realistic.
    await apiFetch(`/api/campaigns/${campaign.id}/stages/${stage1.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "pending" }),
    });
    await apiFetch(`/api/campaigns/${campaign.id}/stages/${stage1.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "sent" }),
    });

    // ============ [1] Saved mapping CRUD ============
    console.log("\n[1] Saved mapping CRUD");
    const mapCreateR = await apiFetch("/api/result-import-mappings", {
      method: "POST",
      body: JSON.stringify({
        sms_provider_id: provider.id,
        name: `Default RI mapping ${unique}`,
        is_default: true,
        mapping: {
          phone_number: "Phone",
          status: "Delivery Status",
          is_optout: "Opted Out",
          is_clicker: "Clicked URL",
          cost: "Cost",
        },
        status_value_map: {
          delivered: ["DELIVERED", "OK"],
          failed: ["FAILED"],
          opt_out: ["STOP", "UNSUBSCRIBE"],
        },
      }),
    });
    check("mapping create 201", mapCreateR.status === 201);
    const mapping1 = (await mapCreateR.json()) as { id: number };
    createdMappingIds.push(mapping1.id);

    const listR = await apiFetch(
      `/api/result-import-mappings/list?provider_id=${provider.id}`,
    );
    const listBody = (await listR.json()) as { data: { id: number }[] };
    check(
      "mapping list contains the new mapping",
      listBody.data.some((m) => m.id === mapping1.id),
    );

    const patchR = await apiFetch(
      `/api/result-import-mappings/${mapping1.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ name: "Renamed mapping" }),
      },
    );
    check("mapping patch 200", patchR.status === 200);

    // Create a SECOND mapping for the same provider with is_default=true.
    // The first should be cleared.
    const map2R = await apiFetch("/api/result-import-mappings", {
      method: "POST",
      body: JSON.stringify({
        sms_provider_id: provider.id,
        name: `Second mapping ${unique}`,
        is_default: true,
        mapping: { phone_number: "Phone" },
      }),
    });
    check("mapping #2 create 201", map2R.status === 201);
    const mapping2 = (await map2R.json()) as { id: number };
    createdMappingIds.push(mapping2.id);

    // Only one default should exist.
    const defaultsCount = await db
      .select({ id: result_import_mappings.id })
      .from(result_import_mappings)
      .where(
        eq(result_import_mappings.is_default, true),
      );
    const myDefaults = defaultsCount.filter((d) =>
      createdMappingIds.includes(d.id),
    );
    check(
      "exactly one default per (org, provider)",
      myDefaults.length === 1 && myDefaults[0].id === mapping2.id,
    );

    // set-default on mapping1 swaps the default back.
    const setDefR = await apiFetch(
      `/api/result-import-mappings/${mapping1.id}/set-default`,
      { method: "POST" },
    );
    check("set-default 200", setDefR.status === 200);
    const m1 = (await setDefR.json()) as { is_default: boolean };
    check("mapping1 is_default = true after set-default", m1.is_default === true);

    // delete mapping2
    const delR = await apiFetch(`/api/result-import-mappings/${mapping2.id}`, {
      method: "DELETE",
    });
    check("mapping #2 delete 200", delR.status === 200);
    createdMappingIds.splice(createdMappingIds.indexOf(mapping2.id), 1);

    // ============ [2] Import preview ============
    console.log("\n[2] Import preview");
    // 10 rows: 6 delivered, 1 failed, 2 opt-out, 1 clicker (mixed phone formats)
    const csvHeaders = [
      "Phone",
      "Delivery Status",
      "Opted Out",
      "Clicked URL",
      "Cost",
    ];
    const csvRows = [
      // delivered
      ...phones.slice(0, 6).map((p) => ({
        Phone: p,
        "Delivery Status": "DELIVERED",
        "Opted Out": "",
        "Clicked URL": "",
        Cost: "0.0150",
      })),
      // failed
      {
        Phone: phones[6],
        "Delivery Status": "FAILED",
        "Opted Out": "",
        "Clicked URL": "",
        Cost: "0.0150",
      },
      // opt-outs
      {
        Phone: phones[7],
        "Delivery Status": "STOP",
        "Opted Out": "",
        "Clicked URL": "",
        Cost: "0.0150",
      },
      {
        Phone: phones[8],
        "Delivery Status": "DELIVERED",
        "Opted Out": "1",
        "Clicked URL": "",
        Cost: "0.0150",
      },
      // clicker
      {
        Phone: phones[9],
        "Delivery Status": "DELIVERED",
        "Opted Out": "",
        "Clicked URL": "1",
        Cost: "0.0150",
      },
    ];
    const csv = buildCsv(csvHeaders, csvRows);

    const mappingBody = {
      phone_number: "Phone",
      status: "Delivery Status",
      is_optout: "Opted Out",
      is_clicker: "Clicked URL",
      cost: "Cost",
    };
    const statusMap = {
      delivered: ["DELIVERED", "OK"],
      failed: ["FAILED"],
      opt_out: ["STOP", "UNSUBSCRIBE"],
    };

    const previewR = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${stage1.id}/import-preview`,
      {
        method: "POST",
        body: JSON.stringify({
          csv_content: csv,
          mapping: mappingBody,
          status_value_map: statusMap,
        }),
      },
    );
    check("preview 200", previewR.status === 200);
    const preview = (await previewR.json()) as {
      submitted: number;
      parsed: number;
      invalid_phone: number;
      by_outcome: Record<string, number>;
      sample_rows: { outcome: string; phone_number: string }[];
      existing_in_db: number;
    };
    check("preview submitted = 10", preview.submitted === 10);
    check("preview parsed = 10", preview.parsed === 10);
    check("preview invalid_phone = 0", preview.invalid_phone === 0);
    check("preview by_outcome.delivered = 6", preview.by_outcome.delivered === 6);
    check("preview by_outcome.failed = 1", preview.by_outcome.failed === 1);
    check("preview by_outcome.optout = 2", preview.by_outcome.optout === 2);
    check("preview by_outcome.clicker = 1", preview.by_outcome.clicker === 1);
    check("preview existing_in_db = 0 (first run)", preview.existing_in_db === 0);
    check(
      "preview sample_rows populated across outcomes",
      preview.sample_rows.length >= 4,
    );

    // ============ [3] Import — first run ============
    console.log("\n[3] Import — first run");
    const importR = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${stage1.id}/import`,
      {
        method: "POST",
        body: JSON.stringify({
          csv_content: csv,
          mapping: mappingBody,
          status_value_map: statusMap,
          mapping_id: mapping1.id,
          filename: "results-1.csv",
          confirm: true,
        }),
      },
    );
    check("import 201", importR.status === 201);
    const importBody = (await importR.json()) as {
      id: number;
      processed_rows: number;
      delivered_added: number;
      failed_added: number;
      optouts_added: number;
      clickers_added: number;
      total_cost_added: number;
      skipped_idempotent: number;
    };
    check("import processed_rows = 10", importBody.processed_rows === 10);
    // The clicker row (#10) also has status=DELIVERED, so per spec
    // deriveOutcome sets both is_clicker and is_delivered — meaning
    // delivered_added = 6 plain + 1 clicker-also-delivered = 7.
    check(
      "import delivered_added = 7 (incl. clicker who is also delivered)",
      importBody.delivered_added === 7,
      `got ${importBody.delivered_added}`,
    );
    check("import failed_added = 1", importBody.failed_added === 1);
    check("import optouts_added = 2", importBody.optouts_added === 2);
    check("import clickers_added = 1", importBody.clickers_added === 1);

    // Verify DB side-effects.
    const allRowsForImport = await db
      .select()
      .from(stage_result_rows)
      .where(eq(stage_result_rows.import_id, importBody.id));
    check(
      "10 stage_result_rows for the import",
      allRowsForImport.length === 10,
    );

    // Stage counters incremented.
    const stageRow = (await (
      await apiFetch(`/api/campaigns/${campaign.id}/stages/${stage1.id}`)
    ).json()) as {
      sms_count: number;
      delivered_count: number;
      opt_out_count: number;
      click_count: number;
      total_cost: string;
    };
    check("stage.sms_count = 10", stageRow.sms_count === 10);
    check(
      "stage.delivered_count = 7 (incl. clicker-also-delivered)",
      stageRow.delivered_count === 7,
      `got ${stageRow.delivered_count}`,
    );
    check("stage.opt_out_count = 2", stageRow.opt_out_count === 2);
    check("stage.click_count = 1", stageRow.click_count === 1);

    // 2 new opt_outs (linked to brand) and 1 new clicker.
    const optoutRowsAfter = await db
      .select({ id: opt_outs.id, phone_number: opt_outs.phone_number })
      .from(opt_outs)
      .where(inArray(opt_outs.phone_number, [phones[7], phones[8]]));
    check("2 opt_outs created", optoutRowsAfter.length === 2);

    const clickerRowsAfter = await db
      .select({ id: clickers.id })
      .from(clickers)
      .where(eq(clickers.phone_number, phones[9]));
    check("1 clicker created", clickerRowsAfter.length === 1);

    // ============ [4] Idempotency ============
    console.log("\n[4] Idempotency — re-import the same CSV");
    const reimportR = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${stage1.id}/import`,
      {
        method: "POST",
        body: JSON.stringify({
          csv_content: csv,
          mapping: mappingBody,
          status_value_map: statusMap,
          mapping_id: mapping1.id,
          filename: "results-1-rerun.csv",
          confirm: true,
        }),
      },
    );
    check("re-import 201", reimportR.status === 201);
    const reimportBody = (await reimportR.json()) as {
      id: number;
      processed_rows: number;
      skipped_idempotent: number;
    };
    check(
      "re-import processed_rows = 0 (all idempotent skips)",
      reimportBody.processed_rows === 0,
    );
    check(
      "re-import skipped_idempotent = 10",
      reimportBody.skipped_idempotent === 10,
    );
    // Stage counters unchanged.
    const stageRowAfterRerun = (await (
      await apiFetch(`/api/campaigns/${campaign.id}/stages/${stage1.id}`)
    ).json()) as { sms_count: number };
    check(
      "stage.sms_count still = 10 after re-import",
      stageRowAfterRerun.sms_count === 10,
    );

    // ============ [5] Revert ============
    console.log("\n[5] Revert");
    const revertR = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${stage1.id}/imports/${importBody.id}/revert`,
      { method: "POST" },
    );
    check("revert 200", revertR.status === 200);
    const revertBody = (await revertR.json()) as {
      import: { reverted_at: string | null; reverted_by_user_id: string | null };
      removed_opt_outs: number;
      removed_clickers: number;
    };
    check("revert sets reverted_at", revertBody.import.reverted_at !== null);
    check(
      "revert sets reverted_by_user_id",
      revertBody.import.reverted_by_user_id !== null,
    );

    // stage_result_rows for that import are gone.
    const remainingRows = await db
      .select({ id: stage_result_rows.id })
      .from(stage_result_rows)
      .where(eq(stage_result_rows.import_id, importBody.id));
    check("stage_result_rows for revoked import are gone", remainingRows.length === 0);

    // opt_outs and clickers from that import are also gone.
    const optoutsAfterRevert = await db
      .select({ id: opt_outs.id })
      .from(opt_outs)
      .where(inArray(opt_outs.phone_number, [phones[7], phones[8]]));
    check("opt_outs removed on revert", optoutsAfterRevert.length === 0);
    const clickersAfterRevert = await db
      .select({ id: clickers.id })
      .from(clickers)
      .where(eq(clickers.phone_number, phones[9]));
    check("clicker removed on revert", clickersAfterRevert.length === 0);

    // Stage counters return to pre-import.
    const stageAfterRevert = (await (
      await apiFetch(`/api/campaigns/${campaign.id}/stages/${stage1.id}`)
    ).json()) as { sms_count: number; delivered_count: number };
    check(
      "stage.sms_count back to 0",
      stageAfterRevert.sms_count === 0,
    );
    check(
      "stage.delivered_count back to 0",
      stageAfterRevert.delivered_count === 0,
    );

    // Re-running revert returns 409.
    const revertAgainR = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${stage1.id}/imports/${importBody.id}/revert`,
      { method: "POST" },
    );
    check("re-revert returns 409", revertAgainR.status === 409);

    // Contacts remain in the registry.
    const contactsRemain = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(inArray(contacts.phone_number, phones.slice(0, 10)));
    check(
      "contacts remain after revert",
      contactsRemain.length === 10,
    );

    // ============ [6] Cross-import opt-out preservation ============
    console.log("\n[6] Cross-import opt-out preservation");
    // Create a second stage on the same campaign. Import CSV-1 that opts out
    // phone X. Then import CSV-2 (against stage 2) that ALSO opts out phone X.
    // Reverting CSV-1 should leave the opt_out in place because CSV-2 still
    // references it.
    const stage2R = await apiFetch(
      `/api/campaigns/${campaign.id}/stages`,
      {
        method: "POST",
        body: JSON.stringify({
          sms_provider_id: provider.id,
          include_no_status: true,
        }),
      },
    );
    check("seed: stage 2 created", stage2R.status === 201);
    const stage2 = (await stage2R.json()) as { id: number };
    // Move stage2 to sent so realistic.
    await apiFetch(`/api/campaigns/${campaign.id}/stages/${stage2.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "pending" }),
    });
    await apiFetch(`/api/campaigns/${campaign.id}/stages/${stage2.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "sent" }),
    });

    const sharedPhone = phones[10];
    const csvA = buildCsv(csvHeaders, [
      {
        Phone: sharedPhone,
        "Delivery Status": "STOP",
        "Opted Out": "",
        "Clicked URL": "",
        Cost: "0.0150",
      },
    ]);
    const csvB = buildCsv(csvHeaders, [
      {
        Phone: sharedPhone,
        "Delivery Status": "STOP",
        "Opted Out": "",
        "Clicked URL": "",
        Cost: "0.0150",
      },
    ]);
    const importAR = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${stage1.id}/import`,
      {
        method: "POST",
        body: JSON.stringify({
          csv_content: csvA,
          mapping: mappingBody,
          status_value_map: statusMap,
          confirm: true,
        }),
      },
    );
    check("CSV-A import 201", importAR.status === 201);
    const importA = (await importAR.json()) as { id: number };

    const importBR = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${stage2.id}/import`,
      {
        method: "POST",
        body: JSON.stringify({
          csv_content: csvB,
          mapping: mappingBody,
          status_value_map: statusMap,
          confirm: true,
        }),
      },
    );
    check("CSV-B import 201", importBR.status === 201);

    // One opt_out row should exist for sharedPhone, referenced by BOTH
    // stage_result_rows entries.
    const ooRows = await db
      .select({ id: opt_outs.id })
      .from(opt_outs)
      .where(eq(opt_outs.phone_number, sharedPhone));
    check("exactly one opt_out for shared phone", ooRows.length === 1);

    // Revert CSV-A. The opt_out should remain because CSV-B still
    // references it.
    const revertAR = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${stage1.id}/imports/${importA.id}/revert`,
      { method: "POST" },
    );
    check("revert CSV-A 200", revertAR.status === 200);
    const ooAfter = await db
      .select({ id: opt_outs.id })
      .from(opt_outs)
      .where(eq(opt_outs.phone_number, sharedPhone));
    check(
      "opt_out preserved (CSV-B still references it)",
      ooAfter.length === 1,
    );

    // ============ [7] Performance — 5000 rows ============
    console.log("\n[7] Performance — 5000-row import");
    // Need contacts for 5000 phones. Reuse pre-uploaded segment contacts
    // where possible, then add synthetic phones beyond our 50.
    const perfRows: Record<string, string>[] = [];
    const perfPhones: string[] = [];
    const perfBase = String(unique).slice(-6);
    for (let i = 0; i < 5000; i++) {
      // Format: +1 510 2NN NNNN — exchange starts with 2 to satisfy NANP
      // (libphonenumber rejects exchanges starting with 0 or 1).
      const tail = ((Number(perfBase) + i) % 1000000)
        .toString()
        .padStart(6, "0");
      const phone = `+15102${tail}`;
      perfPhones.push(phone);
      perfRows.push({
        Phone: phone,
        "Delivery Status": "DELIVERED",
        "Opted Out": "",
        "Clicked URL": "",
        Cost: "0.0050",
      });
    }
    insertedPhones.push(...perfPhones);
    const perfCsv = buildCsv(csvHeaders, perfRows);

    // Create a fresh stage for the perf test so existing rows don't
    // contaminate.
    const perfStageR = await apiFetch(
      `/api/campaigns/${campaign.id}/stages`,
      {
        method: "POST",
        body: JSON.stringify({ include_no_status: true }),
      },
    );
    check("perf: stage created", perfStageR.status === 201);
    const perfStage = (await perfStageR.json()) as { id: number };

    const perfStart = Date.now();
    const perfImportR = await apiFetch(
      `/api/campaigns/${campaign.id}/stages/${perfStage.id}/import`,
      {
        method: "POST",
        body: JSON.stringify({
          csv_content: perfCsv,
          mapping: mappingBody,
          status_value_map: statusMap,
          confirm: true,
        }),
      },
    );
    const perfMs = Date.now() - perfStart;
    check("perf: 5000 rows imported", perfImportR.status === 201);
    const perfBody = (await perfImportR.json()) as {
      processed_rows: number;
      delivered_added: number;
    };
    check(
      "perf: processed_rows = 5000",
      perfBody.processed_rows === 5000,
      `got ${perfBody.processed_rows}`,
    );
    check(
      "perf: completed in under 30s",
      perfMs < 30_000,
      `took ${perfMs}ms`,
    );
    console.log(`  (perf import took ${perfMs}ms)`);
  } finally {
    console.log("\nCleanup");
    try {
      // Campaigns cascade to stages, stages cascade to imports + result rows.
      for (const cid of createdCampaignIds) {
        await db.delete(campaigns).where(eq(campaigns.id, cid));
      }
      // Imports may have cleanly cascaded, but be defensive.
      for (const mid of createdMappingIds) {
        await db
          .delete(result_import_mappings)
          .where(eq(result_import_mappings.id, mid));
      }
      // Opt-outs and clickers created by tests — clean up by phone.
      if (insertedPhones.length > 0) {
        await db
          .delete(opt_outs)
          .where(inArray(opt_outs.phone_number, insertedPhones));
        await db
          .delete(clickers)
          .where(inArray(clickers.phone_number, insertedPhones));
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
      for (const oid of createdOfferIds) {
        await db.delete(offers).where(eq(offers.id, oid));
      }
      for (const pid of createdProviderIds) {
        await db.delete(sms_providers).where(eq(sms_providers.id, pid));
      }
      for (const bid of createdBrandIds) {
        await db.delete(brands).where(eq(brands.id, bid));
      }
      // Silence unused-import warnings on the dev-helper tables.
      void stage_results_imports;
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
