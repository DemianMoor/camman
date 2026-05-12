import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import Papa from "papaparse";
import postgres from "postgres";

import { brands, contacts, opt_outs } from "../db/schema";

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
  const insertedPhones: string[] = [];
  const createdBrandIds: number[] = [];
  let orgId: string | null = null;
  let probeBrandId = 0;

  try {
    // Probe brand to discover org_id.
    const probeR = await apiFetch("/api/brands", {
      method: "POST",
      body: JSON.stringify({
        name: "CSV Probe",
        brand_id: `CSV-PROBE-${unique}`,
      }),
    });
    if (probeR.status !== 201) {
      console.error("Couldn't create probe brand", await probeR.text());
      process.exit(1);
    }
    const probe = (await probeR.json()) as { id: number; org_id: string };
    orgId = probe.org_id;
    probeBrandId = probe.id;
    createdBrandIds.push(probe.id);

    console.log("\n[1] Upload 100 distinct contacts");
    const phones: string[] = [];
    for (let i = 0; i < 100; i++) {
      phones.push(`+1202555${String(i).padStart(4, "0")}`);
    }
    insertedPhones.push(...phones);
    const uploadR = await apiFetch("/api/contacts/upload", {
      method: "POST",
      body: JSON.stringify({ phones: phones.join("\n") }),
    });
    check("upload returns 201", uploadR.status === 201);
    const uploadSum = await uploadR.json();
    check("inserted = 100", uploadSum.inserted === 100);

    console.log("\n[2] GET /api/contacts/export");
    const exportR = await apiFetch("/api/contacts/export");
    check("returns 200", exportR.status === 200);
    check(
      "Content-Type is text/csv",
      (exportR.headers.get("content-type") ?? "").startsWith("text/csv"),
      `got ${exportR.headers.get("content-type")}`,
    );
    const disp = exportR.headers.get("content-disposition") ?? "";
    check("Content-Disposition has attachment", disp.includes("attachment"));
    check("filename ends in .csv", /filename="[^"]+\.csv"/.test(disp));

    const csvText = await exportR.text();
    const parsed = Papa.parse<string[]>(csvText, { skipEmptyLines: true });
    const rows = parsed.data;
    check("CSV parses without errors", parsed.errors.length === 0);
    // Headers must match the contacts export shape.
    check(
      "header row matches expected columns",
      rows[0]?.join(",") === "Phone Number,Country,Archived,Created At",
      `got ${rows[0]?.join(",")}`,
    );
    check(
      "at least 100 data rows present (our test contacts + any existing)",
      rows.length - 1 >= 100,
      `got ${rows.length - 1}`,
    );

    // CSV exports must emit US numbers as bare 10-digit national format —
    // no "+", no spaces, no dashes. The stored E.164 +12025550199 becomes
    // "2025550199".
    const phoneColIdx = rows[0].indexOf("Phone Number");
    check("Phone Number column present", phoneColIdx >= 0);
    const expectedPhone = phones[0].slice(2); // strip "+1" → 10 digits
    const ourRow = rows.find((r) => r[phoneColIdx] === expectedPhone);
    check(
      "first uploaded US phone appears as bare 10 digits",
      ourRow !== undefined,
      `expected to find ${expectedPhone} in phone column`,
    );
    const tenDigitRows = rows
      .slice(1)
      .filter((r) => /^\+12025/.test(r[phoneColIdx]) === false)
      .filter((r) => /^2025/.test(r[phoneColIdx]));
    check(
      "no exported phone has a leading + or country-code prefix",
      tenDigitRows.length > 0 &&
        rows.slice(1).every((r) => !r[phoneColIdx].startsWith("+")),
    );
    check(
      "all our test phones are exactly 10 digits in the CSV",
      phones.every((p) => {
        const expected = p.slice(2);
        const row = rows.find((r) => r[phoneColIdx] === expected);
        return row !== undefined && /^\d{10}$/.test(row[phoneColIdx]);
      }),
    );

    console.log("\n[3] Filter parity with /api/contacts/list");
    // Pick a search prefix that matches only our test data.
    const search = `+1202555`;
    const [listR, expR] = await Promise.all([
      apiFetch(
        `/api/contacts/list?search=${encodeURIComponent(search)}&pageSize=200`,
      ),
      apiFetch(`/api/contacts/export?search=${encodeURIComponent(search)}`),
    ]);
    const listBody = (await listR.json()) as { totalCount: number };
    const expCsv = await expR.text();
    const expRows = Papa.parse<string[]>(expCsv, {
      skipEmptyLines: true,
    }).data;
    // expRows includes a header line.
    check(
      "export row count matches list totalCount",
      expRows.length - 1 === listBody.totalCount,
      `list=${listBody.totalCount}, export=${expRows.length - 1}`,
    );

    console.log("\n[4] CSV escaping — opt-out with comma in source");
    const optOutPhone = `+1202666${String(unique).slice(-4)}`;
    insertedPhones.push(optOutPhone);
    const oo = await apiFetch("/api/opt-outs/upload", {
      method: "POST",
      body: JSON.stringify({
        phones: optOutPhone,
        brand_ids: [probeBrandId],
        source: "campaign, q1, multi-word",
      }),
    });
    check("opt-out upload returns 201", oo.status === 201);

    const ooExportR = await apiFetch(
      `/api/opt-outs/export?search=${encodeURIComponent(optOutPhone)}`,
    );
    check("opt-outs export returns 200", ooExportR.status === 200);
    const ooCsv = await ooExportR.text();
    const ooRows = Papa.parse<string[]>(ooCsv, { skipEmptyLines: true }).data;
    // Header + at least one row.
    check("opt-outs export has rows", ooRows.length >= 2);
    const sourceColIdx = ooRows[0].indexOf("Source");
    check("Source column exists in header", sourceColIdx >= 0);
    const sourceValue = ooRows[1]?.[sourceColIdx];
    check(
      "Source with comma round-trips through CSV escaping",
      sourceValue === "campaign, q1, multi-word",
      `got: ${JSON.stringify(sourceValue)}`,
    );
    // Also assert the raw CSV contains a quoted source field.
    check(
      "raw CSV quotes the comma-bearing field",
      ooCsv.includes('"campaign, q1, multi-word"'),
    );

    console.log("\n[5] Performance — 5000-row export under 30s end-to-end");
    const big: string[] = [];
    for (let i = 0; i < 5000; i++) {
      big.push(`+1213700${String(i).padStart(4, "0")}`);
    }
    insertedPhones.push(...big);
    const tUploadStart = performance.now();
    const upR = await apiFetch("/api/contacts/upload", {
      method: "POST",
      body: JSON.stringify({ phones: big.join("\n") }),
    });
    const uploadElapsed = performance.now() - tUploadStart;
    check("perf upload returns 201", upR.status === 201);

    const tExportStart = performance.now();
    const perfExportR = await apiFetch(
      "/api/contacts/export?search=+1213700",
    );
    // Drain the body to ensure we're timing the whole stream, not just headers.
    const perfText = await perfExportR.text();
    const exportElapsed = performance.now() - tExportStart;
    const perfRowCount =
      Papa.parse<string[]>(perfText, { skipEmptyLines: true }).data.length - 1;
    console.log(
      `    upload 5000: ${uploadElapsed.toFixed(0)}ms, export+drain: ${exportElapsed.toFixed(0)}ms, rows=${perfRowCount}`,
    );
    check(
      "export returned at least 5000 rows",
      perfRowCount >= 5000,
      `got ${perfRowCount}`,
    );
    check(
      "export completed under 30s",
      exportElapsed < 30000,
      `${exportElapsed.toFixed(0)}ms`,
    );

    console.log("\n[6] Authorization — 401 without cookies");
    const unauthR = await fetch(`${appUrl}/api/contacts/export`);
    check("unauthenticated GET returns 401", unauthR.status === 401);
  } finally {
    console.log("\nCleanup");
    try {
      if (insertedPhones.length > 0) {
        await db
          .delete(opt_outs)
          .where(inArray(opt_outs.phone_number, insertedPhones));
        await db
          .delete(contacts)
          .where(inArray(contacts.phone_number, insertedPhones));
      }
      for (const bid of createdBrandIds) {
        await db.delete(brands).where(eq(brands.id, bid));
      }
      void orgId;
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
