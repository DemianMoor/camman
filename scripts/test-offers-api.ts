import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { offers } from "../db/schema";

type SalesPage = { label: string; url: string };

type Offer = {
  id: number;
  offer_id: string;
  name: string;
  postfix: string | null;
  base_url: string | null;
  network_id: number | null;
  payout_model: "cpa" | "revshare";
  payout_cpa: string | null;
  payout_revshare: string | null;
  sales_pages: SalesPage[];
  status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
  org_id: string;
};

type ListResponse = {
  data: (Offer & {
    network: { id: number; name: string } | null;
  })[];
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

  const createdIds: number[] = [];
  const unique = Date.now();
  const cpaOfferId = `OFF-CPA-${unique}`;
  const rsOfferId = `OFF-RS-${unique}`;

  try {
    console.log("\n[1] GET /api/offers/list (initial)");
    const r1 = await apiFetch("/api/offers/list");
    check("returns 200", r1.status === 200);
    const body1 = (await r1.json()) as ListResponse;
    const initialCount = body1.totalCount;
    console.log(`    initial totalCount = ${initialCount}`);

    console.log("\n[2] POST /api/offers (create CPA)");
    const r2 = await apiFetch("/api/offers", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Offer CPA",
        offer_id: cpaOfferId,
        payout_model: "cpa",
        payout_cpa: 25.5,
      }),
    });
    check("returns 201", r2.status === 201, `got ${r2.status}`);
    const cpaCreated = (await r2.json()) as Offer;
    check("payout_model is cpa", cpaCreated.payout_model === "cpa");
    check(
      "payout_cpa persisted",
      Number(cpaCreated.payout_cpa) === 25.5,
      `got ${cpaCreated.payout_cpa}`,
    );
    check("payout_revshare null", cpaCreated.payout_revshare === null);
    createdIds.push(cpaCreated.id);

    console.log("\n[3] POST /api/offers (duplicate offer_id)");
    const r3 = await apiFetch("/api/offers", {
      method: "POST",
      body: JSON.stringify({
        name: "Dup",
        offer_id: cpaOfferId,
        payout_model: "cpa",
        payout_cpa: 10,
      }),
    });
    check("returns 409", r3.status === 409, `got ${r3.status}`);
    const body3 = await r3.json();
    check("code is duplicate", body3.code === "duplicate");
    check("details.field is offer_id", body3.details?.field === "offer_id");

    console.log("\n[4] POST /api/offers (revshare + sales_pages)");
    const r4 = await apiFetch("/api/offers", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Offer RevShare",
        offer_id: rsOfferId,
        payout_model: "revshare",
        payout_revshare: 30,
        sales_pages: [
          { label: "Variant A", url: "https://example.com/a" },
          { label: "Variant B", url: "https://example.com/b" },
        ],
      }),
    });
    check("returns 201", r4.status === 201, `got ${r4.status}`);
    const rsCreated = (await r4.json()) as Offer;
    check("payout_model is revshare", rsCreated.payout_model === "revshare");
    check(
      "payout_revshare persisted",
      Number(rsCreated.payout_revshare) === 30,
      `got ${rsCreated.payout_revshare}`,
    );
    check("payout_cpa null", rsCreated.payout_cpa === null);
    check(
      "sales_pages length 2",
      Array.isArray(rsCreated.sales_pages) && rsCreated.sales_pages.length === 2,
    );
    createdIds.push(rsCreated.id);

    console.log("\n[5] POST /api/offers (cpa missing payout_cpa)");
    const r5 = await apiFetch("/api/offers", {
      method: "POST",
      body: JSON.stringify({
        name: "Missing CPA",
        offer_id: `OFF-BAD-${unique}`,
        payout_model: "cpa",
      }),
    });
    check("returns 400", r5.status === 400, `got ${r5.status}`);
    const body5 = await r5.json();
    check("code is validation", body5.code === "validation");

    console.log("\n[6] GET /api/offers/list (after creates)");
    const r6 = await apiFetch("/api/offers/list");
    const body6 = (await r6.json()) as ListResponse;
    check(
      "totalCount increased by 2",
      body6.totalCount === initialCount + 2,
      `expected ${initialCount + 2}, got ${body6.totalCount}`,
    );
    const cpaRow = body6.data.find((o) => o.id === cpaCreated.id);
    check("CPA offer present in list", cpaRow !== undefined);
    check(
      "joined network is null (no networks yet)",
      cpaRow?.network === null,
      `got ${JSON.stringify(cpaRow?.network)}`,
    );

    console.log(`\n[7] GET /api/offers/${rsCreated.id}`);
    const r7 = await apiFetch(`/api/offers/${rsCreated.id}`);
    check("returns 200", r7.status === 200);
    const got = (await r7.json()) as Offer;
    check("sales_pages preserved", got.sales_pages.length === 2);
    check(
      "sales_pages[0].label correct",
      got.sales_pages[0]?.label === "Variant A",
    );

    console.log("\n[8] GET /api/offers/99999 (nonexistent)");
    const r8 = await apiFetch("/api/offers/99999");
    check("returns 404", r8.status === 404);
    const body8 = await r8.json();
    check("code is not_found", body8.code === "not_found");
    check("details.entity is offer", body8.details?.entity === "offer");

    console.log(`\n[9] PATCH /api/offers/${rsCreated.id} (replace sales_pages)`);
    const r9 = await apiFetch(`/api/offers/${rsCreated.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: "RenamedRS",
        sales_pages: [
          { label: "Only one", url: "https://example.com/only" },
        ],
      }),
    });
    check("returns 200", r9.status === 200, `got ${r9.status}`);
    const patched = (await r9.json()) as Offer;
    check("name updated", patched.name === "RenamedRS");
    check(
      "sales_pages replaced (length 1)",
      patched.sales_pages.length === 1 &&
        patched.sales_pages[0]?.label === "Only one",
    );

    console.log(`\n[10] POST /api/offers/${cpaCreated.id}/archive`);
    const r10 = await apiFetch(`/api/offers/${cpaCreated.id}/archive`, {
      method: "POST",
    });
    check("returns 200", r10.status === 200, `got ${r10.status}`);
    const archived = (await r10.json()) as Offer;
    check("status is archived", archived.status === "archived");

    console.log("\n[11] GET /api/offers/list (default — archived hidden)");
    const r11 = await apiFetch("/api/offers/list");
    const body11 = (await r11.json()) as ListResponse;
    check(
      "archived offer NOT in default list",
      !body11.data.some((o) => o.id === cpaCreated.id),
    );

    console.log("\n[12] GET /api/offers/list?showArchived=true");
    const r12 = await apiFetch("/api/offers/list?showArchived=true");
    const body12 = (await r12.json()) as ListResponse;
    check(
      "archived offer IS in showArchived list",
      body12.data.some((o) => o.id === cpaCreated.id),
    );

    console.log(`\n[13] POST /api/offers/${cpaCreated.id}/restore`);
    const r13 = await apiFetch(`/api/offers/${cpaCreated.id}/restore`, {
      method: "POST",
    });
    check("returns 200", r13.status === 200, `got ${r13.status}`);
    const restored = (await r13.json()) as Offer;
    check("status is active", restored.status === "active");
  } finally {
    if (createdIds.length > 0) {
      console.log(
        `\nCleanup: hard-deleting test offer ids=${createdIds.join(",")}`,
      );
      const pg = postgres(dbUrl, { prepare: false, max: 1 });
      const db = drizzle(pg);
      try {
        for (const id of createdIds) {
          const deleted = await db
            .delete(offers)
            .where(eq(offers.id, id))
            .returning({ id: offers.id });
          console.log(`  deleted ${deleted.length} row(s) for id=${id}`);
        }
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
