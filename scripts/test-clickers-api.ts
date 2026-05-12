import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { brands, clickers, contacts, offers } from "../db/schema";

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
  const createdOfferIds: number[] = [];
  const insertedPhones: string[] = [];
  let orgId: string | null = null;

  try {
    const probeR = await apiFetch("/api/brands", {
      method: "POST",
      body: JSON.stringify({
        name: "CL Probe",
        brand_id: `PROBE-CL-${unique}`,
      }),
    });
    if (probeR.status !== 201) {
      console.error("Couldn't create probe brand", await probeR.text());
      process.exit(1);
    }
    const probe = (await probeR.json()) as { id: number; org_id: string };
    orgId = probe.org_id;
    createdBrandIds.push(probe.id);

    const offer = await db
      .insert(offers)
      .values({
        org_id: orgId,
        name: "CL Test Offer",
        offer_id: `CL-OFFER-${unique}`,
        payout_model: "cpa",
        payout_cpa: "1.00",
        sales_pages: [],
        status: "active",
      })
      .returning({ id: offers.id });
    createdOfferIds.push(offer[0].id);

    const u4 = String(unique).slice(-4);
    const phones = [`+1404555${u4}1`, `+1404555${u4}2`];
    insertedPhones.push(...phones);

    console.log("\n[1] POST upload with brand_id (required) + offer_id");
    const r1 = await apiFetch("/api/clickers/upload", {
      method: "POST",
      body: JSON.stringify({
        phones: phones.join("\n"),
        brand_id: probe.id,
        offer_id: offer[0].id,
        source: "test",
      }),
    });
    check("returns 201", r1.status === 201, `got ${r1.status}`);
    const s1 = await r1.json();
    check("inserted = 2", s1.inserted === 2);

    console.log("\n[2] POST upload without brand_id (should fail)");
    const r2 = await apiFetch("/api/clickers/upload", {
      method: "POST",
      body: JSON.stringify({ phones: phones.join("\n") }),
    });
    check("returns 400", r2.status === 400);

    console.log(`\n[3] GET list?offer_id=${offer[0].id}`);
    const r3 = await apiFetch(
      `/api/clickers/list?offer_id=${offer[0].id}&pageSize=100`,
    );
    const body3 = await r3.json();
    const our = body3.data.filter((r: { phone_number: string }) =>
      insertedPhones.includes(r.phone_number),
    );
    check("offer filter works", our.length === 2);
    check(
      "offer joined",
      our.every(
        (r: { offer: { id: number } | null }) =>
          r.offer !== null && r.offer.id === offer[0].id,
      ),
    );

    console.log("\n[4] POST bulk-delete");
    const r4 = await apiFetch("/api/clickers/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids: our.map((r: { id: number }) => r.id) }),
    });
    check("returns 200", r4.status === 200);
    const body4 = await r4.json();
    check("deleted_clickers = 2", body4.deleted_clickers === 2);
  } finally {
    console.log("\nCleanup");
    try {
      if (insertedPhones.length > 0) {
        await db
          .delete(clickers)
          .where(inArray(clickers.phone_number, insertedPhones));
        await db
          .delete(contacts)
          .where(inArray(contacts.phone_number, insertedPhones));
      }
      for (const oid of createdOfferIds) {
        await db.delete(offers).where(eq(offers.id, oid));
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
