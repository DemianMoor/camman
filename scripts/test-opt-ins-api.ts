import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { brands, contacts, opt_ins, sms_providers } from "../db/schema";

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
  const createdBrandIds: number[] = [];
  const createdOptInIds: number[] = [];
  const insertedPhones: string[] = [];
  let orgId: string | null = null;

  try {
    const probeR = await apiFetch("/api/brands", {
      method: "POST",
      body: JSON.stringify({
        name: "OI Probe",
        brand_id: `PROBE-OI-${unique}`,
      }),
    });
    if (probeR.status !== 201) {
      console.error("Couldn't create probe brand", await probeR.text());
      process.exit(1);
    }
    const probe = (await probeR.json()) as { id: number; org_id: string };
    orgId = probe.org_id;
    createdBrandIds.push(probe.id);

    const u4 = String(unique).slice(-4);
    const phones = [`+1213600${u4}1`, `+1213600${u4}2`];
    insertedPhones.push(...phones);

    console.log("\n[1] POST upload (2 phones, with brand)");
    const r1 = await apiFetch("/api/opt-ins/upload", {
      method: "POST",
      body: JSON.stringify({
        phones: phones.join("\n"),
        brand_id: probe.id,
        source: "test",
      }),
    });
    check("returns 201", r1.status === 201, `got ${r1.status}`);
    const s1 = await r1.json();
    check("inserted = 2", s1.inserted === 2);

    console.log("\n[2] GET list");
    const r2 = await apiFetch("/api/opt-ins/list?pageSize=100");
    const body2 = await r2.json();
    const our = body2.data.filter((r: { phone_number: string }) =>
      insertedPhones.includes(r.phone_number),
    );
    createdOptInIds.push(...our.map((r: { id: number }) => r.id));
    check("2 rows for our phones", our.length === 2);
    check(
      "brand joined",
      our.every(
        (r: { brand: { id: number } | null }) =>
          r.brand !== null && r.brand.id === probe.id,
      ),
    );

    console.log(`\n[3] GET list?brand_id=${probe.id}`);
    const r3 = await apiFetch(
      `/api/opt-ins/list?brand_id=${probe.id}&pageSize=100`,
    );
    const body3 = await r3.json();
    const ourFiltered = body3.data.filter((r: { phone_number: string }) =>
      insertedPhones.includes(r.phone_number),
    );
    check("brand filter works", ourFiltered.length === 2);

    console.log("\n[4] DELETE single via /[id]");
    const r4 = await apiFetch(`/api/opt-ins/${our[0].id}`, { method: "DELETE" });
    check("returns 200", r4.status === 200);

    console.log("\n[5] POST bulk-delete (the second one)");
    const r5 = await apiFetch("/api/opt-ins/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids: [our[1].id] }),
    });
    check("returns 200", r5.status === 200);
    const body5 = await r5.json();
    check("deleted_opt_ins = 1", body5.deleted_opt_ins === 1);

    console.log("\n[6] Performance: 500-phone upload");
    const big: string[] = [];
    for (let i = 0; i < 500; i++) {
      big.push(`+1213700${String(i).padStart(4, "0")}`);
      insertedPhones.push(`+1213700${String(i).padStart(4, "0")}`);
    }
    const t0 = performance.now();
    const r6 = await apiFetch("/api/opt-ins/upload", {
      method: "POST",
      body: JSON.stringify({
        phones: big.join("\n"),
        brand_id: probe.id,
        source: "perf",
      }),
    });
    const elapsedMs = performance.now() - t0;
    check("returns 201", r6.status === 201, `got ${r6.status}`);
    console.log(`    perf: 500-row upload in ${elapsedMs.toFixed(0)}ms`);
    check("under 8s", elapsedMs < 8000, `${elapsedMs.toFixed(0)}ms`);
  } finally {
    console.log("\nCleanup");
    try {
      if (insertedPhones.length > 0) {
        await db
          .delete(opt_ins)
          .where(inArray(opt_ins.phone_number, insertedPhones));
        await db
          .delete(contacts)
          .where(inArray(contacts.phone_number, insertedPhones));
      }
      for (const bid of createdBrandIds) {
        await db.delete(brands).where(eq(brands.id, bid));
      }
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
