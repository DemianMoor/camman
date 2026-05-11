import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { traffic_types } from "../db/schema";

type TrafficType = {
  id: number;
  traffic_type_id: string;
  name: string;
  description: string | null;
  color: string | null;
  status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
  org_id: string;
};
type ListResponse = { data: TrafficType[]; totalCount: number };

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
      console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
      failed++;
    }
  }

  const createdIds: number[] = [];
  const unique = Date.now();
  const slug = `TT-${unique}`;

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  try {
    console.log("\n[1] GET /api/traffic-types/list (initial)");
    const r1 = await apiFetch("/api/traffic-types/list");
    check("returns 200", r1.status === 200);
    const body1 = (await r1.json()) as ListResponse;
    const initialCount = body1.totalCount;

    console.log("\n[2] POST /api/traffic-types (create)");
    const r2 = await apiFetch("/api/traffic-types", {
      method: "POST",
      body: JSON.stringify({
        name: "Display Ads",
        traffic_type_id: slug,
        description: "Banner / display network traffic",
        color: "#3B82F6",
      }),
    });
    check("returns 201", r2.status === 201, `got ${r2.status}`);
    const tt = (await r2.json()) as TrafficType;
    check("description persisted", tt.description === "Banner / display network traffic");
    createdIds.push(tt.id);

    console.log("\n[3] POST /api/traffic-types (duplicate)");
    const r3 = await apiFetch("/api/traffic-types", {
      method: "POST",
      body: JSON.stringify({ name: "Dup", traffic_type_id: slug }),
    });
    check("returns 409", r3.status === 409);
    const body3 = await r3.json();
    check("code is duplicate", body3.code === "duplicate");
    check(
      "details.field is traffic_type_id",
      body3.details?.field === "traffic_type_id",
    );

    console.log(`\n[4] GET /api/traffic-types/${tt.id}`);
    const r4 = await apiFetch(`/api/traffic-types/${tt.id}`);
    check("returns 200", r4.status === 200);

    console.log("\n[5] GET /api/traffic-types/99999");
    const r5 = await apiFetch("/api/traffic-types/99999");
    check("returns 404", r5.status === 404);
    const body5 = await r5.json();
    check("code is not_found", body5.code === "not_found");
    check(
      "details.entity is traffic_type",
      body5.details?.entity === "traffic_type",
    );

    console.log(`\n[6] PATCH /api/traffic-types/${tt.id}`);
    const r6 = await apiFetch(`/api/traffic-types/${tt.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Display Ads (renamed)" }),
    });
    check("returns 200", r6.status === 200);

    console.log(`\n[7] POST /api/traffic-types/${tt.id}/archive`);
    const r7 = await apiFetch(`/api/traffic-types/${tt.id}/archive`, {
      method: "POST",
    });
    check("returns 200", r7.status === 200);

    console.log("\n[8] GET /api/traffic-types/list (archived hidden)");
    const r8 = await apiFetch("/api/traffic-types/list");
    const body8 = (await r8.json()) as ListResponse;
    check(
      "archived not in default list",
      !body8.data.some((x) => x.id === tt.id),
    );

    console.log("\n[9] GET /api/traffic-types/list?showArchived=true");
    const r9 = await apiFetch("/api/traffic-types/list?showArchived=true");
    const body9 = (await r9.json()) as ListResponse;
    check(
      "archived IS in showArchived list",
      body9.data.some((x) => x.id === tt.id),
    );

    console.log(`\n[10] POST /api/traffic-types/${tt.id}/restore`);
    const r10 = await apiFetch(`/api/traffic-types/${tt.id}/restore`, {
      method: "POST",
    });
    check("returns 200", r10.status === 200);
    check(
      "status is active",
      ((await r10.json()) as TrafficType).status === "active",
    );

    console.log(`\n    final initialCount delta = ${body9.totalCount - initialCount}`);
  } finally {
    console.log("\nCleanup");
    try {
      for (const id of createdIds) {
        const d = await db
          .delete(traffic_types)
          .where(eq(traffic_types.id, id))
          .returning({ id: traffic_types.id });
        console.log(`  deleted id=${id} (${d.length} row)`);
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
