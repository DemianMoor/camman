import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { provider_phones, sms_providers } from "../db/schema";

type Provider = {
  id: number;
  sms_provider_id: string;
  org_id: string;
  name: string;
  short_link_supported: boolean;
  short_link_example: string | null;
  avatar_url: string | null;
  color: string | null;
  status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
};

type ProviderListRow = Provider & { phone_count: number };
type ListResponse = {
  data: ProviderListRow[];
  totalCount: number;
};

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const appUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
  const dbUrl = process.env.DATABASE_URL;
  const testEmail = process.env.TEST_USER_EMAIL;
  const testPassword = process.env.TEST_USER_PASSWORD;

  if (!url || !anonKey || !dbUrl) {
    console.error("Missing required env vars");
    process.exit(1);
  }
  if (!testEmail || !testPassword) {
    console.error(
      "Set TEST_USER_EMAIL and TEST_USER_PASSWORD in .env.local to run this test.",
    );
    process.exit(1);
  }

  const cookieJar = new Map<string, string>();
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return Array.from(cookieJar.entries()).map(([name, value]) => ({
          name,
          value,
        }));
      },
      setAll(cookies) {
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
      console.log(
        `  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`,
      );
      failed++;
    }
  }

  const createdIds: number[] = [];
  const createdPhoneIds: number[] = [];
  const unique = Date.now();
  const firstId = `SMSP-${unique}-A`;
  const secondId = `SMSP-${unique}-B`;

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  try {
    console.log("\n[1] GET /api/providers/list (initial)");
    const r1 = await apiFetch("/api/providers/list");
    check("returns 200", r1.status === 200);
    const body1 = (await r1.json()) as ListResponse;
    const initialCount = body1.totalCount;

    console.log("\n[2] POST /api/providers (create A)");
    const r2 = await apiFetch("/api/providers", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Provider A",
        sms_provider_id: firstId,
        short_link_supported: true,
        short_link_example: "lnk.example.com/abc",
      }),
    });
    check("returns 201", r2.status === 201, `got ${r2.status}`);
    const provA = (await r2.json()) as Provider;
    check(
      "short_link_supported is true",
      provA.short_link_supported === true,
    );
    createdIds.push(provA.id);

    console.log("\n[3] POST /api/providers (duplicate)");
    const r3 = await apiFetch("/api/providers", {
      method: "POST",
      body: JSON.stringify({ name: "Dup", sms_provider_id: firstId }),
    });
    check("returns 409", r3.status === 409);
    const body3 = await r3.json();
    check("code is duplicate", body3.code === "duplicate");
    check(
      "details.field is sms_provider_id",
      body3.details?.field === "sms_provider_id",
    );

    console.log(`\n[4] GET /api/providers/${provA.id}`);
    const r4 = await apiFetch(`/api/providers/${provA.id}`);
    check("returns 200", r4.status === 200);

    console.log("\n[5] GET /api/providers/99999");
    const r5 = await apiFetch("/api/providers/99999");
    check("returns 404", r5.status === 404);

    console.log(`\n[6] PATCH /api/providers/${provA.id}`);
    const r6 = await apiFetch(`/api/providers/${provA.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Test Provider A Renamed" }),
    });
    check("returns 200", r6.status === 200);

    console.log(`\n[7] POST /api/providers/${provA.id}/archive`);
    const r7 = await apiFetch(`/api/providers/${provA.id}/archive`, {
      method: "POST",
    });
    check("returns 200", r7.status === 200);
    const archived = (await r7.json()) as Provider;
    check("status archived", archived.status === "archived");

    console.log("\n[8] GET list (archived hidden by default)");
    const r8 = await apiFetch("/api/providers/list");
    const body8 = (await r8.json()) as ListResponse;
    check(
      "archived not in default list",
      !body8.data.some((p) => p.id === provA.id),
    );

    console.log(`\n[9] POST /api/providers/${provA.id}/restore`);
    const r9 = await apiFetch(`/api/providers/${provA.id}/restore`, {
      method: "POST",
    });
    check("returns 200", r9.status === 200);

    // phone_count test
    console.log("\n[10] Create provider B + add a phone, check phone_count");
    const r10 = await apiFetch("/api/providers", {
      method: "POST",
      body: JSON.stringify({ name: "Test Provider B", sms_provider_id: secondId }),
    });
    check("provider B created", r10.status === 201);
    const provB = (await r10.json()) as Provider;
    createdIds.push(provB.id);

    const inserted = await db
      .insert(provider_phones)
      .values({
        org_id: provB.org_id,
        provider_id: provB.id,
        phone_number: `+1202555${String(unique).slice(-4)}`,
        country_code: "US",
        dial_code: "+1",
        local_number: `202555${String(unique).slice(-4)}`,
        cost_per_sms: "0.01",
        status: "active",
      })
      .returning({ id: provider_phones.id });
    createdPhoneIds.push(inserted[0].id);

    const r11 = await apiFetch("/api/providers/list?pageSize=100");
    const body11 = (await r11.json()) as ListResponse;
    const rowA = body11.data.find((p) => p.id === provA.id);
    const rowB = body11.data.find((p) => p.id === provB.id);
    check("Provider A phone_count = 0", rowA?.phone_count === 0);
    check("Provider B phone_count = 1", rowB?.phone_count === 1);

    console.log(`\n    final initialCount delta = ${body11.totalCount - initialCount}`);
  } finally {
    console.log("\nCleanup");
    try {
      for (const id of createdPhoneIds) {
        const d = await db
          .delete(provider_phones)
          .where(eq(provider_phones.id, id))
          .returning({ id: provider_phones.id });
        console.log(`  deleted phone id=${id} (${d.length} row)`);
      }
      for (const id of createdIds) {
        const d = await db
          .delete(sms_providers)
          .where(eq(sms_providers.id, id))
          .returning({ id: sms_providers.id });
        console.log(`  deleted provider id=${id} (${d.length} row)`);
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
