// Verifies the "Used Campaigns" column on /api/creatives/list
// (docs/superpowers/specs/2026-09-15-creatives-used-campaigns-design.md).
// READ-ONLY. Expected counts come from a separate postgres connection with the
// campaign de-duplication done in JS, so they share no statement with the route;
// the most-used creative is also cross-checked against a different endpoint,
// /api/creatives/[id]/usage (lib/reporting/grading.ts).
//
// Live sends can stamp sent_at mid-run, so the independent count is taken before
// AND after the API read and creatives whose count moved are reported, not
// compared.
//
// Dev server:  npx tsx scripts/verify-creatives-used-campaigns.ts
// Production:  BASE_URL=https://camman.vercel.app npx tsx scripts/verify-creatives-used-campaigns.ts
// Requires TEST_USER_EMAIL / TEST_USER_PASSWORD / DATABASE_URL in .env.local.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import postgres from "postgres";

type Row = { id: number; org_id: string; used_campaigns?: unknown; metrics?: unknown };
type ListResponse = { data: Row[]; totalCount: number };

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  const suffix = ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${suffix}`);
  if (!ok) failures++;
}

const used = (r: Row) => r.used_campaigns as number;

// First out-of-order position, or null. Ties must be broken by id ascending.
function orderViolation(rows: Row[], dir: "asc" | "desc") {
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1];
    const c = rows[i];
    const bad =
      used(p) === used(c) ? p.id > c.id : dir === "desc" ? used(p) < used(c) : used(p) > used(c);
    if (bad) return { at: i, prev: [p.id, used(p)], cur: [c.id, used(c)] };
  }
  return null;
}

async function main() {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3100";
  const email = process.env.TEST_USER_EMAIL;
  const password = process.env.TEST_USER_PASSWORD;
  const databaseUrl = process.env.DATABASE_URL;
  if (!email || !password || !databaseUrl) {
    console.error("Set TEST_USER_EMAIL, TEST_USER_PASSWORD and DATABASE_URL in .env.local.");
    process.exit(1);
  }

  const jar = new Map<string, string>();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (cookies) => {
          for (const { name, value } of cookies) jar.set(name, value);
        },
      },
    },
  );
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error(`Sign-in failed: ${error.message}`);
    process.exit(1);
  }
  const cookie = [...jar].map(([n, v]) => `${n}=${v}`).join("; ");

  async function get<T>(path: string): Promise<{ body: T; timing: string | null }> {
    const res = await fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie } });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
    return { body: (await res.json()) as T, timing: res.headers.get("x-camman-timing") };
  }
  const list = (qs: string) => get<ListResponse>(`/api/creatives/list?${qs}`);

  const db = postgres(databaseUrl, { prepare: false, max: 1 });
  try {
    console.log(`Target: ${baseUrl}`);

    const probe = await list("showArchived=true&include_metrics=false&pageSize=1");
    const orgId = probe.body.data[0]?.org_id;
    if (!orgId) throw new Error("The test user's org has no creatives");

    async function independentCounts() {
      const rows = await db<{ creative_id: number; campaign_id: number }[]>`
        SELECT creative_id, campaign_id
        FROM campaign_stages
        WHERE org_id = ${orgId} AND creative_id IS NOT NULL AND sent_at IS NOT NULL`;
      const sets = new Map<number, Set<number>>();
      for (const r of rows) {
        const id = Number(r.creative_id);
        const set = sets.get(id) ?? new Set<number>();
        set.add(Number(r.campaign_id));
        sets.set(id, set);
      }
      return new Map([...sets].map(([id, set]) => [id, set.size]));
    }

    console.log("\n[1] Every creative carries used_campaigns");
    const before = await independentCounts();
    const all: Row[] = [];
    let totalCount = Infinity;
    for (let page = 0; all.length < totalCount; page++) {
      const { body } = await list(
        `showArchived=true&include_metrics=false&pageSize=500&page=${page}`,
      );
      totalCount = body.totalCount;
      if (body.data.length === 0) break;
      all.push(...body.data);
    }
    const after = await independentCounts();

    check(`collected all ${totalCount} creatives`, all.length === totalCount, all.length);
    const missing = all.filter((r) => !Number.isInteger(r.used_campaigns)).map((r) => r.id);
    check("every row has a numeric used_campaigns", missing.length === 0, {
      rows_without: missing.length,
    });
    if (missing.length > 0) return;
    check(
      "all rows belong to the test user's org",
      all.every((r) => r.org_id === orgId),
    );

    console.log("\n[2] Values equal the independent count");
    let compared = 0;
    let moved = 0;
    const mismatches: unknown[] = [];
    for (const r of all) {
      const b = before.get(r.id) ?? 0;
      const a = after.get(r.id) ?? 0;
      if (b !== a) {
        moved++;
        continue;
      }
      compared++;
      if (used(r) !== a) mismatches.push({ id: r.id, api: used(r), expected: a });
    }
    check(
      `exact for ${compared} creatives (${moved} moved during the run)`,
      mismatches.length === 0,
      mismatches.slice(0, 10),
    );
    const ids = new Set(all.map((r) => r.id));
    check(
      "every creative with a sent stage is in the list",
      [...after.keys()].every((id) => ids.has(id)),
    );
    const nonZero = all.filter((r) => used(r) > 0).length;
    check(`some creatives are used (${nonZero} > 0, ${all.length - nonZero} at 0)`, nonZero > 0);

    console.log("\n[3] Cross-check against /api/creatives/[id]/usage");
    // Chosen by the INDEPENDENT count, not the API value: an all-zero response
    // would otherwise pick a 0 creative and pass this check vacuously.
    const expected = (r: Row) => after.get(r.id) ?? 0;
    const top = all.reduce((m, r) => (expected(r) > expected(m) ? r : m));
    const expectedMax = expected(top);
    const { body: usage } = await get<{ data: { campaign_id: number }[] }>(
      `/api/creatives/${top.id}/usage`,
    );
    const usageCampaigns = new Set(usage.data.map((u) => u.campaign_id)).size;
    check(
      `most-used creative #${top.id}: list ${used(top)}, usage endpoint ${usageCampaigns}, independent ${expectedMax}`,
      expectedMax > 0 && usageCampaigns === used(top) && used(top) === expectedMax,
    );

    console.log("\n[4] Server-side sort");
    for (const metrics of [false, true]) {
      for (const dir of ["desc", "asc"] as const) {
        const { body, timing } = await list(
          `showArchived=true&include_metrics=${metrics}&pageSize=500&sortBy=used_campaigns&sortDir=${dir}`,
        );
        const bad = orderViolation(body.data, dir);
        check(
          `${dir}, include_metrics=${metrics}: ordered with id tiebreak`,
          bad === null && body.data.length > 1,
          bad,
        );
        if (dir === "desc" && totalCount <= 500) {
          check(`${dir}, include_metrics=${metrics}: first row is the max`, used(body.data[0]) === expectedMax);
        }
        if (dir === "desc") console.log(`    x-camman-timing: ${timing}`);
      }
    }
    const qs = "showArchived=true&include_metrics=false&pageSize=20&sortBy=used_campaigns&sortDir=desc";
    const p0 = await list(`${qs}&page=0`);
    const p1 = await list(`${qs}&page=1`);
    const p0ids = new Set(p0.body.data.map((r) => r.id));
    const overlap = p1.body.data.filter((r) => p0ids.has(r.id)).map((r) => r.id);
    check("pages 0 and 1 share no ids", overlap.length === 0 && p1.body.data.length > 0, overlap);

    console.log("\n[5] Default request (metrics on) also carries it");
    const def = await list("pageSize=20");
    check(
      "every row has used_campaigns and metrics",
      def.body.data.length > 0 &&
        def.body.data.every((r) => Number.isInteger(r.used_campaigns) && r.metrics !== undefined),
    );
  } finally {
    await db.end();
    console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
