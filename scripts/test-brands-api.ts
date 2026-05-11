import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// Mirrors the schema-import that lives in db/schema.ts; we pull it from there
// so cleanup uses the same column types.
import { brands } from "../db/schema";

type Brand = {
  id: number;
  brand_id: string;
  name: string;
  status: string;
  color: string | null;
  short_link_base: string | null;
  avatar_url: string | null;
  archived_at: string | null;
  created_at: string;
  org_id: string;
};

type ListResponse = {
  data: Brand[];
  totalCount: number;
  page: number;
  pageSize: number;
};

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const appUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
  const dbUrl = process.env.DATABASE_URL;
  const testEmail = process.env.TEST_USER_EMAIL;
  const testPassword = process.env.TEST_USER_PASSWORD;

  if (!url || !anonKey || !dbUrl) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / DATABASE_URL",
    );
    process.exit(1);
  }
  if (!testEmail || !testPassword) {
    console.error(
      "Set TEST_USER_EMAIL and TEST_USER_PASSWORD in .env.local to run this test.",
    );
    process.exit(1);
  }

  // Cookie jar acts as a one-tab browser for @supabase/ssr.
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

  let createdId: number | null = null;
  const unique = Date.now();
  const testBrandId = `TEST-${unique}`;

  try {
    console.log("\n[1] GET /api/brands/list (initial)");
    const r1 = await apiFetch("/api/brands/list");
    check("returns 200", r1.status === 200);
    const body1 = (await r1.json()) as ListResponse;
    check("response has totalCount", typeof body1.totalCount === "number");
    const initialCount = body1.totalCount;
    console.log(`    initial totalCount = ${initialCount}`);

    console.log("\n[2] POST /api/brands (create)");
    const r2 = await apiFetch("/api/brands", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Brand 1",
        brand_id: testBrandId,
        color: "#FF5733",
      }),
    });
    check("returns 201", r2.status === 201, `got ${r2.status}`);
    const created = (await r2.json()) as Brand;
    check("created brand has id", typeof created.id === "number");
    check("created brand status is active", created.status === "active");
    check("color persisted", created.color === "#FF5733");
    createdId = created.id;

    console.log("\n[3] POST /api/brands (duplicate brand_id)");
    const r3 = await apiFetch("/api/brands", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Brand 2",
        brand_id: testBrandId,
      }),
    });
    check("returns 409", r3.status === 409, `got ${r3.status}`);
    const body3 = await r3.json();
    check(
      "code is duplicate_brand_id",
      body3.code === "duplicate_brand_id",
      `got code=${body3.code}`,
    );

    console.log("\n[4] GET /api/brands/list (after create)");
    const r4 = await apiFetch("/api/brands/list");
    const body4 = (await r4.json()) as ListResponse;
    check(
      "totalCount increased by 1",
      body4.totalCount === initialCount + 1,
      `expected ${initialCount + 1}, got ${body4.totalCount}`,
    );
    check(
      "new brand present in data",
      body4.data.some((b) => b.id === createdId),
    );

    console.log(`\n[5] GET /api/brands/${createdId}`);
    const r5 = await apiFetch(`/api/brands/${createdId}`);
    check("returns 200", r5.status === 200);
    const got = (await r5.json()) as Brand;
    check("returned brand matches", got.id === createdId);

    console.log("\n[6] GET /api/brands/99999 (nonexistent)");
    const r6 = await apiFetch("/api/brands/99999");
    check("returns 404", r6.status === 404);
    const body6 = await r6.json();
    check("code is brand_not_found", body6.code === "brand_not_found");

    console.log(`\n[7] PATCH /api/brands/${createdId} (rename)`);
    const r7 = await apiFetch(`/api/brands/${createdId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Test Brand 1 Renamed" }),
    });
    check("returns 200", r7.status === 200, `got ${r7.status}`);
    const patched = (await r7.json()) as Brand;
    check("name updated", patched.name === "Test Brand 1 Renamed");

    console.log(`\n[8] PATCH /api/brands/${createdId} (empty body)`);
    const r8 = await apiFetch(`/api/brands/${createdId}`, {
      method: "PATCH",
      body: JSON.stringify({}),
    });
    check("returns 400", r8.status === 400);

    console.log(`\n[9] POST /api/brands/${createdId}/archive`);
    const r9 = await apiFetch(`/api/brands/${createdId}/archive`, {
      method: "POST",
    });
    check("returns 200", r9.status === 200, `got ${r9.status}`);
    const archived = (await r9.json()) as Brand;
    check("status is archived", archived.status === "archived");
    check("archived_at set", archived.archived_at !== null);

    console.log("\n[10] GET /api/brands/list (showArchived=false)");
    const r10 = await apiFetch("/api/brands/list");
    const body10 = (await r10.json()) as ListResponse;
    check(
      "archived brand NOT in default list",
      !body10.data.some((b) => b.id === createdId),
    );

    console.log("\n[11] GET /api/brands/list?showArchived=true");
    const r11 = await apiFetch("/api/brands/list?showArchived=true");
    const body11 = (await r11.json()) as ListResponse;
    check(
      "archived brand IS in showArchived list",
      body11.data.some((b) => b.id === createdId),
    );

    console.log(`\n[12] POST /api/brands/${createdId}/archive (already archived)`);
    const r12 = await apiFetch(`/api/brands/${createdId}/archive`, {
      method: "POST",
    });
    check(
      "returns 404 or 409",
      r12.status === 404 || r12.status === 409,
      `got ${r12.status}`,
    );

    console.log(`\n[13] POST /api/brands/${createdId}/restore`);
    const r13 = await apiFetch(`/api/brands/${createdId}/restore`, {
      method: "POST",
    });
    check("returns 200", r13.status === 200, `got ${r13.status}`);
    const restored = (await r13.json()) as Brand;
    check("status is active after restore", restored.status === "active");
    check("archived_at cleared", restored.archived_at === null);
  } finally {
    // Cleanup — hard delete via Drizzle so the test doesn't pollute the brand list.
    if (createdId !== null) {
      console.log(`\nCleanup: hard-deleting test brand id=${createdId}`);
      const pg = postgres(dbUrl, { prepare: false, max: 1 });
      const db = drizzle(pg);
      try {
        const deleted = await db
          .delete(brands)
          .where(eq(brands.id, createdId))
          .returning({ id: brands.id });
        console.log(`  deleted ${deleted.length} row(s)`);
      } finally {
        await pg.end({ timeout: 5 });
      }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
