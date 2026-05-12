import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { affiliate_networks, utm_tags } from "../db/schema";

type UtmTag = {
  id: number;
  tag_id: string;
  label: string;
  value_source: string;
  affiliate_network_id: number | null;
  color: string | null;
  status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
  org_id: string;
};
type UtmTagListRow = UtmTag & {
  network: { id: number; name: string; color: string | null } | null;
};
type ListResponse = { data: UtmTagListRow[]; totalCount: number };

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

  const createdTagIds: number[] = [];
  const createdNetworkIds: number[] = [];
  const unique = Date.now();
  const unscopedSlug = `UTM-${unique}-A`;
  const scopedSlug = `UTM-${unique}-B`;

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  try {
    // Setup: probe the API to discover the test user's org_id (returned in any
    // created row), then insert the test network with that org_id. We can't
    // insert the network with a placeholder org_id first because the FK to
    // organizations rejects nonexistent values.
    console.log("\n[setup] Probe API to learn org_id, then insert test network");
    const seedListR = await apiFetch("/api/utm-tags/list");
    const seedList = (await seedListR.json()) as ListResponse;
    const initialCount = seedList.totalCount;
    console.log(`    initial totalCount = ${initialCount}`);

    const probeR = await apiFetch("/api/utm-tags", {
      method: "POST",
      body: JSON.stringify({
        label: "Probe",
        tag_id: `UTM-PROBE-${unique}`,
        value_source: "literal",
      }),
    });
    if (probeR.status !== 201) {
      console.error(`Probe create failed: ${probeR.status}`);
      console.error(await probeR.text());
      process.exit(1);
    }
    const probe = (await probeR.json()) as UtmTag;
    createdTagIds.push(probe.id);
    const orgId = probe.org_id;

    const netInsert = await db
      .insert(affiliate_networks)
      .values({
        org_id: orgId,
        network_id: `UTM-TEST-NET-${unique}`,
        name: "UTM Test Network",
        color: "#3B82F6",
        status: "active",
      })
      .returning();
    createdNetworkIds.push(netInsert[0].id);

    console.log("\n[1] POST /api/utm-tags (unscoped tag, no network)");
    const r1 = await apiFetch("/api/utm-tags", {
      method: "POST",
      body: JSON.stringify({
        label: "Brand name",
        tag_id: unscopedSlug,
        value_source: "brand_name",
      }),
    });
    check("returns 201", r1.status === 201, `got ${r1.status}`);
    const unscoped = (await r1.json()) as UtmTag;
    check(
      "affiliate_network_id is null",
      unscoped.affiliate_network_id === null,
    );
    createdTagIds.push(unscoped.id);

    console.log("\n[2] POST /api/utm-tags (scoped tag, with network)");
    const r2 = await apiFetch("/api/utm-tags", {
      method: "POST",
      body: JSON.stringify({
        label: "Sub ID for Test Network",
        tag_id: scopedSlug,
        value_source: "campaign_slug",
        affiliate_network_id: netInsert[0].id,
      }),
    });
    check("returns 201", r2.status === 201, `got ${r2.status}`);
    const scoped = (await r2.json()) as UtmTag;
    check(
      "affiliate_network_id persisted",
      scoped.affiliate_network_id === netInsert[0].id,
    );
    createdTagIds.push(scoped.id);

    console.log("\n[3] POST /api/utm-tags (duplicate tag_id)");
    const r3 = await apiFetch("/api/utm-tags", {
      method: "POST",
      body: JSON.stringify({
        label: "Dup",
        tag_id: unscopedSlug,
        value_source: "literal",
      }),
    });
    check("returns 409", r3.status === 409);
    const body3 = await r3.json();
    check("code is duplicate", body3.code === "duplicate");
    check("details.field is tag_id", body3.details?.field === "tag_id");

    console.log("\n[4] GET /api/utm-tags/list (verify joined network info)");
    const r4 = await apiFetch("/api/utm-tags/list?pageSize=100");
    const body4 = (await r4.json()) as ListResponse;
    const rowUnscoped = body4.data.find((t) => t.id === unscoped.id);
    const rowScoped = body4.data.find((t) => t.id === scoped.id);
    check(
      "unscoped tag has network=null",
      rowUnscoped?.network === null,
      `got ${JSON.stringify(rowUnscoped?.network)}`,
    );
    check(
      "scoped tag has network object",
      rowScoped?.network !== null && rowScoped?.network?.id === netInsert[0].id,
    );
    check(
      "scoped tag network.name is correct",
      rowScoped?.network?.name === "UTM Test Network",
    );

    console.log("\n[5] GET /api/utm-tags/list?affiliate_network_id=N filters");
    const r5 = await apiFetch(
      `/api/utm-tags/list?affiliate_network_id=${netInsert[0].id}`,
    );
    const body5 = (await r5.json()) as ListResponse;
    check(
      "scoped tag appears",
      body5.data.some((t) => t.id === scoped.id),
    );
    check(
      "unscoped tag is filtered out",
      !body5.data.some((t) => t.id === unscoped.id),
    );

    console.log(`\n[6] PATCH /api/utm-tags/${unscoped.id}`);
    const r6 = await apiFetch(`/api/utm-tags/${unscoped.id}`, {
      method: "PATCH",
      body: JSON.stringify({ label: "Brand name (renamed)" }),
    });
    check("returns 200", r6.status === 200);

    console.log("\n[7] GET /api/utm-tags/99999");
    const r7 = await apiFetch("/api/utm-tags/99999");
    check("returns 404", r7.status === 404);
    const body7 = await r7.json();
    check("code is not_found", body7.code === "not_found");
    check("details.entity is utm_tag", body7.details?.entity === "utm_tag");

    console.log(`\n[8] POST /api/utm-tags/${unscoped.id}/archive`);
    const r8 = await apiFetch(`/api/utm-tags/${unscoped.id}/archive`, {
      method: "POST",
    });
    check("returns 200", r8.status === 200);

    console.log("\n[9] GET /api/utm-tags/list (archived hidden)");
    const r9 = await apiFetch("/api/utm-tags/list");
    const body9 = (await r9.json()) as ListResponse;
    check(
      "archived not in default list",
      !body9.data.some((t) => t.id === unscoped.id),
    );

    console.log(`\n[10] POST /api/utm-tags/${unscoped.id}/restore`);
    const r10 = await apiFetch(`/api/utm-tags/${unscoped.id}/restore`, {
      method: "POST",
    });
    check("returns 200", r10.status === 200);

    console.log(`\n    final delta = ${body4.totalCount - initialCount}`);
  } finally {
    console.log("\nCleanup");
    try {
      for (const id of createdTagIds) {
        const d = await db
          .delete(utm_tags)
          .where(eq(utm_tags.id, id))
          .returning({ id: utm_tags.id });
        console.log(`  deleted tag id=${id} (${d.length} row)`);
      }
      for (const id of createdNetworkIds) {
        const d = await db
          .delete(affiliate_networks)
          .where(eq(affiliate_networks.id, id))
          .returning({ id: affiliate_networks.id });
        console.log(`  deleted network id=${id} (${d.length} row)`);
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
