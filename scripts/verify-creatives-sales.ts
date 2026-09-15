// Verifies the creatives list sales metrics
// (docs/superpowers/specs/2026-09-15-creatives-sales-fix-design.md):
//   metrics.sales           — 30-day sales (stages created in the last 30 days)
//   metrics.sales_lifetime  — all-time sales
//   metrics.sales_cr        — sales / clean_clicks
// plus the revenue behind EPC, which moved to the same per-stage Keitaro pass.
// READ-ONLY. Expected values are recounted from raw rows on a separate postgres
// connection — stage rows and Keitaro rows fetched separately, the per-stage
// max(manual tally, Keitaro conversions) rule and the per-creative sums done in
// JS — so they share no statement with lib/creatives/metrics-cache.ts.
//
// Keitaro rows change every 5 minutes, so the recount runs before AND after the
// request that fills the metrics cache; creatives whose recount moved are
// reported, not compared. On a warm cache (x-camman-timing mcache ~0 ms) the
// served values can be up to 15 minutes old — the script says so.
//
// Dev server:  npx tsx scripts/verify-creatives-sales.ts   (restart it first so the cache is cold)
// Production:  BASE_URL=https://camman.vercel.app npx tsx scripts/verify-creatives-sales.ts
// Requires TEST_USER_EMAIL / TEST_USER_PASSWORD / DATABASE_URL in .env.local.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import postgres from "postgres";

type Metrics = {
  sales: number;
  sales_lifetime?: unknown;
  sales_cr: number | null;
  clean_clicks: number;
  payout: number;
  clean_clicks_lifetime: number;
  epc_lifetime: number | null;
};
type Row = { id: number; org_id: string; metrics?: Metrics };
type ListResponse = { data: Row[]; totalCount: number };
type Expected = { sales30: number; salesAll: number; payout30: number; payoutAll: number };

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  const suffix = ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${suffix}`);
  if (!ok) failures++;
}
const close = (a: number, b: number, eps = 0.005) => Math.abs(a - b) <= eps;

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

  async function list(qs: string): Promise<{ body: ListResponse; timing: string }> {
    const res = await fetch(`${baseUrl}/api/creatives/list?${qs}`, { headers: { Cookie: cookie } });
    if (!res.ok) throw new Error(`GET ?${qs} → ${res.status} ${await res.text()}`);
    return { body: (await res.json()) as ListResponse, timing: res.headers.get("x-camman-timing") ?? "" };
  }

  const db = postgres(databaseUrl, { prepare: false, max: 2 });
  try {
    console.log(`Target: ${baseUrl}`);
    const probe = await list("showArchived=true&include_metrics=false&pageSize=1");
    const orgId = probe.body.data[0]?.org_id;
    if (!orgId) throw new Error("The test user's org has no creatives");

    async function recount(): Promise<Map<number, Expected>> {
      const [stages, keitaro] = await Promise.all([
        db<{ id: number; creative_id: number; sales_count: number; recent: boolean }[]>`
          SELECT id, creative_id, sales_count, created_at >= now() - interval '30 days' AS recent
          FROM campaign_stages
          WHERE org_id = ${orgId} AND creative_id IS NOT NULL`,
        db<{ stage_id: number; sales: number; revenue: string }[]>`
          SELECT stage_id, sales, revenue FROM keitaro_stage_results WHERE org_id = ${orgId}`,
      ]);
      const perStage = new Map<number, { sales: number; revenue: number }>();
      for (const k of keitaro) {
        const e = perStage.get(Number(k.stage_id)) ?? { sales: 0, revenue: 0 };
        e.sales += Number(k.sales);
        e.revenue += Number(k.revenue);
        perStage.set(Number(k.stage_id), e);
      }
      const out = new Map<number, Expected>();
      for (const s of stages) {
        const k = perStage.get(Number(s.id)) ?? { sales: 0, revenue: 0 };
        const effective = Math.max(Number(s.sales_count), k.sales);
        const e = out.get(Number(s.creative_id)) ?? { sales30: 0, salesAll: 0, payout30: 0, payoutAll: 0 };
        e.salesAll += effective;
        e.payoutAll += k.revenue;
        if (s.recent) {
          e.sales30 += effective;
          e.payout30 += k.revenue;
        }
        out.set(Number(s.creative_id), e);
      }
      return out;
    }
    const zero: Expected = { sales30: 0, salesAll: 0, payout30: 0, payoutAll: 0 };

    console.log("\n[1] Every creative carries the sales metrics");
    const before = await recount();
    const all: Row[] = [];
    let totalCount = Infinity;
    let firstTiming = "";
    for (let page = 0; all.length < totalCount; page++) {
      const { body, timing } = await list(`showArchived=true&pageSize=500&page=${page}`);
      if (page === 0) firstTiming = timing;
      totalCount = body.totalCount;
      if (body.data.length === 0) break;
      all.push(...body.data);
    }
    const after = await recount();
    const mcache = Number(/mcache;dur=([\d.]+)/.exec(firstTiming)?.[1] ?? "0");
    console.log(`    metrics cache on first request: ${mcache > 200 ? "COLD (computed now)" : `WARM (${mcache} ms) — values may be up to 15 min old`}`);

    check(`collected all ${totalCount} creatives`, all.length === totalCount, all.length);
    const missing = all.filter((r) => !Number.isInteger(r.metrics?.sales_lifetime)).map((r) => r.id);
    check("every row has an integer metrics.sales_lifetime", missing.length === 0, {
      rows_without: missing.length,
    });
    if (missing.length > 0) return;
    const m = (r: Row) => r.metrics!;
    const lifetime = (r: Row) => m(r).sales_lifetime as number;

    console.log("\n[2] Values equal the independent recount");
    const stable = all.filter((r) => {
      const b = before.get(r.id) ?? zero;
      const a = after.get(r.id) ?? zero;
      return b.sales30 === a.sales30 && b.salesAll === a.salesAll && close(b.payout30, a.payout30) && close(b.payoutAll, a.payoutAll);
    });
    console.log(`    comparing ${stable.length} creatives (${all.length - stable.length} moved during the run)`);
    const bad = (label: string, pred: (r: Row, e: Expected) => boolean, show: (r: Row, e: Expected) => unknown) => {
      const rows = stable.filter((r) => !pred(r, after.get(r.id) ?? zero));
      check(label, rows.length === 0, rows.slice(0, 8).map((r) => ({ id: r.id, ...(show(r, after.get(r.id) ?? zero) as object) })));
    };
    bad("sales (30d) exact", (r, e) => m(r).sales === e.sales30, (r, e) => ({ api: m(r).sales, expected: e.sales30 }));
    bad("sales_lifetime exact", (r, e) => lifetime(r) === e.salesAll, (r, e) => ({ api: lifetime(r), expected: e.salesAll }));
    bad("payout (30d) matches", (r, e) => close(m(r).payout, e.payout30), (r, e) => ({ api: m(r).payout, expected: e.payout30 }));
    bad(
      "lifetime revenue behind EPC (all time) matches",
      (r, e) =>
        m(r).clean_clicks_lifetime > 0
          ? close((m(r).epc_lifetime ?? 0) * m(r).clean_clicks_lifetime, e.payoutAll, 0.02)
          : m(r).epc_lifetime === null,
      (r, e) => ({ epc_lifetime: m(r).epc_lifetime, clicks: m(r).clean_clicks_lifetime, expected_revenue: e.payoutAll }),
    );
    const crBad = all.filter((r) => {
      const want = m(r).clean_clicks > 0 ? m(r).sales / m(r).clean_clicks : null;
      const got = m(r).sales_cr;
      return want === null ? got !== null : got === null || Math.abs(got - want) > 1e-9;
    });
    check("sales_cr = sales / clean_clicks (null when no clicks)", crBad.length === 0, crBad.slice(0, 5).map((r) => r.id));

    const withCr = all.filter((r) => (m(r).sales_cr ?? 0) > 0).length;
    const withLifetime = all.filter((r) => lifetime(r) > 0).length;
    check(`Sales CR is non-zero somewhere (${withCr} creatives)`, withCr > 0);
    check(`some creatives have all-time sales (${withLifetime})`, withLifetime > 0);
    const totals = all.reduce((t, r) => ({ s30: t.s30 + m(r).sales, sAll: t.sAll + lifetime(r) }), { s30: 0, sAll: 0 });
    console.log(`    totals: ${totals.s30} sales (30d), ${totals.sAll} sales (all time)`);

    console.log("\n[3] Server-side sort by sales_lifetime");
    const expectedMax = Math.max(0, ...[...after.values()].map((e) => e.salesAll));
    for (const dir of ["desc", "asc"] as const) {
      const { body } = await list(`showArchived=true&pageSize=500&sortBy=sales_lifetime&sortDir=${dir}`);
      let violation: unknown = null;
      for (let i = 1; i < body.data.length && violation === null; i++) {
        const p = body.data[i - 1];
        const c = body.data[i];
        const out = lifetime(p) === lifetime(c) ? p.id > c.id : dir === "desc" ? lifetime(p) < lifetime(c) : lifetime(p) > lifetime(c);
        if (out) violation = { at: i, prev: [p.id, lifetime(p)], cur: [c.id, lifetime(c)] };
      }
      check(`${dir}: ordered with id tiebreak`, violation === null && body.data.length > 1, violation);
      if (dir === "desc" && totalCount <= 500) {
        check(`desc: first row is the max (${expectedMax})`, lifetime(body.data[0]) === expectedMax, lifetime(body.data[0]));
      }
    }
    const fallback = await list("showArchived=true&include_metrics=false&pageSize=5&sortBy=sales_lifetime&sortDir=desc");
    check("sortBy=sales_lifetime without metrics still answers", fallback.body.data.length > 0);
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
