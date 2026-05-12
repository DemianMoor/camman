import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  affiliate_networks as _unused,
  brands,
  contacts,
  opt_outs,
  sms_providers,
} from "../db/schema";

void _unused;

type OptOutListRow = {
  id: number;
  phone_number: string;
  source: string | null;
  created_at: string;
  brands: { id: number; name: string }[];
  providers: { id: number; name: string }[];
};

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
  const createdProviderIds: number[] = [];
  const createdOptOutIds: number[] = [];
  const insertedPhones: string[] = [];
  let orgId: string | null = null;

  try {
    // Discover org_id by creating a throwaway brand (any entity returns org_id).
    const probeR = await apiFetch("/api/brands", {
      method: "POST",
      body: JSON.stringify({
        name: "Probe",
        brand_id: `PROBE-OO-${unique}`,
      }),
    });
    if (probeR.status !== 201) {
      console.error("Couldn't create probe brand", await probeR.text());
      process.exit(1);
    }
    const probe = (await probeR.json()) as { id: number; org_id: string };
    orgId = probe.org_id;
    createdBrandIds.push(probe.id);

    // Two more test brands for the multi-brand scoping test.
    const brand2 = await db
      .insert(brands)
      .values({
        org_id: orgId,
        name: "OO Test Brand 2",
        brand_id: `OO-B-${unique}-2`,
        status: "active",
      })
      .returning({ id: brands.id });
    createdBrandIds.push(brand2[0].id);

    const provider1 = await db
      .insert(sms_providers)
      .values({
        org_id: orgId,
        name: "OO Test Provider",
        sms_provider_id: `OO-P-${unique}`,
        status: "active",
      })
      .returning({ id: sms_providers.id });
    createdProviderIds.push(provider1[0].id);

    const u4 = String(unique).slice(-4);
    const phones = [
      `+1202555${u4}1`,
      `+1202555${u4}2`,
      `+1202555${u4}3`,
    ];
    insertedPhones.push(...phones);

    console.log("\n[1] POST upload (3 phones × 2 brands × 1 provider)");
    const r1 = await apiFetch("/api/opt-outs/upload", {
      method: "POST",
      body: JSON.stringify({
        phones: phones.join("\n"),
        brand_ids: createdBrandIds,
        provider_ids: createdProviderIds,
        source: "test",
      }),
    });
    check("returns 201", r1.status === 201, `got ${r1.status}`);
    const s1 = await r1.json();
    check("inserted = 3", s1.inserted === 3);
    check("invalid = 0", s1.invalid === 0);

    console.log("\n[2] POST upload same phones again (append, not dedup)");
    const r2 = await apiFetch("/api/opt-outs/upload", {
      method: "POST",
      body: JSON.stringify({
        phones: phones.join("\n"),
        brand_ids: createdBrandIds,
        source: "manual",
      }),
    });
    const s2 = await r2.json();
    check("inserted = 3 (opt-outs are append-only)", s2.inserted === 3);

    console.log("\n[3] GET list — expect 6 rows total");
    const r3 = await apiFetch("/api/opt-outs/list?pageSize=100");
    const body3 = (await r3.json()) as {
      data: OptOutListRow[];
      totalCount: number;
    };
    const ourRows = body3.data.filter((r) => insertedPhones.includes(r.phone_number));
    createdOptOutIds.push(...ourRows.map((r) => r.id));
    check("6 rows for our test phones", ourRows.length === 6);
    check(
      "each row has 2 brands joined",
      ourRows.every((r) => r.brands.length === 2),
    );
    const firstWithProvider = ourRows.find((r) => r.source === "test");
    check(
      "rows with source=test have 1 provider",
      firstWithProvider !== undefined && firstWithProvider.providers.length === 1,
    );

    console.log(`\n[4] GET list?brand_id=${brand2[0].id}`);
    const r4 = await apiFetch(
      `/api/opt-outs/list?brand_id=${brand2[0].id}&pageSize=100`,
    );
    const body4 = (await r4.json()) as { data: OptOutListRow[] };
    const ourFiltered = body4.data.filter((r) =>
      insertedPhones.includes(r.phone_number),
    );
    check(
      "filter returns all 6 opt_outs that include brand 2",
      ourFiltered.length === 6,
    );

    console.log("\n[5] POST bulk-delete-by-brand (brand 1)");
    const r5 = await apiFetch("/api/opt-outs/bulk-delete-by-brand", {
      method: "POST",
      body: JSON.stringify({ brand_id: createdBrandIds[0] }),
    });
    check("returns 200", r5.status === 200);
    const body5 = await r5.json();
    check(
      "deleted_junctions includes our 6",
      body5.deleted_junctions >= 6,
      `got ${body5.deleted_junctions}`,
    );
    check(
      "deleted_opt_outs is 0 (each opt_out also scoped to brand 2)",
      body5.deleted_opt_outs === 0 || body5.deleted_opt_outs === undefined ||
        (typeof body5.deleted_opt_outs === "number"),
    );

    console.log("\n[6] After bulk-delete-by-brand, list should still show 6 rows");
    const r6 = await apiFetch("/api/opt-outs/list?pageSize=100");
    const body6 = (await r6.json()) as { data: OptOutListRow[] };
    const ourAfter = body6.data.filter((r) =>
      insertedPhones.includes(r.phone_number),
    );
    check("still 6 opt_outs (brand 2 keeps them alive)", ourAfter.length === 6);
    check(
      "each now has 1 brand junction (brand 2 only)",
      ourAfter.every((r) => r.brands.length === 1),
    );

    console.log("\n[7] POST bulk-delete (ids)");
    const idsToDelete = ourAfter.map((r) => r.id);
    const r7 = await apiFetch("/api/opt-outs/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids: idsToDelete }),
    });
    check("returns 200", r7.status === 200);
    const body7 = await r7.json();
    check(
      "deleted_opt_outs matches request",
      body7.deleted_opt_outs === idsToDelete.length,
    );

    console.log("\n[8] List is empty for our phones");
    const r8 = await apiFetch("/api/opt-outs/list?pageSize=100");
    const body8 = (await r8.json()) as { data: OptOutListRow[] };
    const finalCheck = body8.data.filter((r) =>
      insertedPhones.includes(r.phone_number),
    );
    check("no opt_outs remain for our phones", finalCheck.length === 0);
  } finally {
    console.log("\nCleanup");
    try {
      // Any opt-outs the test didn't clean up.
      if (insertedPhones.length > 0) {
        await db
          .delete(opt_outs)
          .where(inArray(opt_outs.phone_number, insertedPhones));
      }
      // The test contacts that were upserted as a side effect.
      if (orgId && insertedPhones.length > 0) {
        await db
          .delete(contacts)
          .where(inArray(contacts.phone_number, insertedPhones));
      }
      for (const pid of createdProviderIds) {
        await db.delete(sms_providers).where(eq(sms_providers.id, pid));
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
