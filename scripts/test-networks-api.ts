import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { affiliate_networks, offers } from "../db/schema";

type Network = {
  id: number;
  network_id: string;
  org_id: string;
  name: string;
  url: string | null;
  avatar_url: string | null;
  color: string | null;
  status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
};

type NetworkListRow = Network & { offer_count: number };

type ListResponse = {
  data: NetworkListRow[];
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

  const createdNetworkIds: number[] = [];
  const createdOfferIds: number[] = [];
  const unique = Date.now();
  const firstId = `NET-${unique}-A`;
  const secondId = `NET-${unique}-B`;

  // Direct DB connection for inserting the test offer + cleanup.
  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  try {
    console.log("\n[1] GET /api/networks/list (initial)");
    const r1 = await apiFetch("/api/networks/list");
    check("returns 200", r1.status === 200);
    const body1 = (await r1.json()) as ListResponse;
    const initialCount = body1.totalCount;

    console.log("\n[2] POST /api/networks (create A)");
    const r2 = await apiFetch("/api/networks", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Network A",
        network_id: firstId,
        url: "https://network-a.example",
      }),
    });
    check("returns 201", r2.status === 201, `got ${r2.status}`);
    const netA = (await r2.json()) as Network;
    check("status is active", netA.status === "active");
    createdNetworkIds.push(netA.id);

    console.log("\n[3] POST /api/networks (duplicate network_id)");
    const r3 = await apiFetch("/api/networks", {
      method: "POST",
      body: JSON.stringify({ name: "Dup", network_id: firstId }),
    });
    check("returns 409", r3.status === 409, `got ${r3.status}`);
    const body3 = await r3.json();
    check("code is duplicate", body3.code === "duplicate");
    check(
      "details.field is network_id",
      body3.details?.field === "network_id",
    );

    console.log(`\n[4] GET /api/networks/${netA.id}`);
    const r4 = await apiFetch(`/api/networks/${netA.id}`);
    check("returns 200", r4.status === 200);
    const got = (await r4.json()) as Network;
    check("returned network matches", got.id === netA.id);

    console.log("\n[5] GET /api/networks/99999 (nonexistent)");
    const r5 = await apiFetch("/api/networks/99999");
    check("returns 404", r5.status === 404);
    const body5 = await r5.json();
    check("code is not_found", body5.code === "not_found");
    check("details.entity is network", body5.details?.entity === "network");

    console.log(`\n[6] PATCH /api/networks/${netA.id} (rename)`);
    const r6 = await apiFetch(`/api/networks/${netA.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Test Network A Renamed" }),
    });
    check("returns 200", r6.status === 200, `got ${r6.status}`);
    const patched = (await r6.json()) as Network;
    check("name updated", patched.name === "Test Network A Renamed");

    console.log(`\n[7] POST /api/networks/${netA.id}/archive`);
    const r7 = await apiFetch(`/api/networks/${netA.id}/archive`, {
      method: "POST",
    });
    check("returns 200", r7.status === 200, `got ${r7.status}`);
    const archived = (await r7.json()) as Network;
    check("status is archived", archived.status === "archived");

    console.log("\n[8] GET /api/networks/list (default — archived hidden)");
    const r8 = await apiFetch("/api/networks/list");
    const body8 = (await r8.json()) as ListResponse;
    check(
      "archived network NOT in default list",
      !body8.data.some((n) => n.id === netA.id),
    );

    console.log("\n[9] GET /api/networks/list?showArchived=true");
    const r9 = await apiFetch("/api/networks/list?showArchived=true");
    const body9 = (await r9.json()) as ListResponse;
    check(
      "archived network IS in showArchived list",
      body9.data.some((n) => n.id === netA.id),
    );

    console.log(`\n[10] POST /api/networks/${netA.id}/archive (already archived)`);
    const r10 = await apiFetch(`/api/networks/${netA.id}/archive`, {
      method: "POST",
    });
    check("returns 409", r10.status === 409, `got ${r10.status}`);
    const body10 = await r10.json();
    check("code is conflict", body10.code === "conflict");

    console.log(`\n[11] POST /api/networks/${netA.id}/restore`);
    const r11 = await apiFetch(`/api/networks/${netA.id}/restore`, {
      method: "POST",
    });
    check("returns 200", r11.status === 200, `got ${r11.status}`);

    // offer_count test: create a second network and a test offer linked to it.
    console.log("\n[12] POST /api/networks (create B for offer_count test)");
    const r12 = await apiFetch("/api/networks", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Network B",
        network_id: secondId,
      }),
    });
    check("returns 201", r12.status === 201, `got ${r12.status}`);
    const netB = (await r12.json()) as Network;
    createdNetworkIds.push(netB.id);

    console.log(
      "\n[13] Direct insert: one active offer linked to network B",
    );
    const orgRow = netB.org_id;
    const inserted = await db
      .insert(offers)
      .values({
        org_id: orgRow,
        offer_id: `OFFER-OC-${unique}`,
        name: "OC Test Offer",
        network_id: netB.id,
        payout_model: "cpa",
        payout_cpa: "10.00",
        sales_pages: [],
        status: "active",
      })
      .returning({ id: offers.id });
    const testOfferId = inserted[0].id;
    createdOfferIds.push(testOfferId);
    console.log(`    inserted offer id=${testOfferId}`);

    console.log("\n[14] GET /api/networks/list (offer_count assertion)");
    const r14 = await apiFetch("/api/networks/list?pageSize=100");
    const body14 = (await r14.json()) as ListResponse;
    const rowA = body14.data.find((n) => n.id === netA.id);
    const rowB = body14.data.find((n) => n.id === netB.id);
    check("Network A offer_count = 0", rowA?.offer_count === 0, `got ${rowA?.offer_count}`);
    check("Network B offer_count = 1", rowB?.offer_count === 1, `got ${rowB?.offer_count}`);

    console.log(`    final initialCount delta = ${body14.totalCount - initialCount}`);
  } finally {
    console.log("\nCleanup");
    try {
      for (const id of createdOfferIds) {
        const d = await db
          .delete(offers)
          .where(eq(offers.id, id))
          .returning({ id: offers.id });
        console.log(`  deleted offer id=${id} (${d.length} row)`);
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
