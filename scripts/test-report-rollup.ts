import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";

import { stageHourAggregate, groupHourAggregate } from "@/lib/reporting/rollup";

// READ-ONLY verification of the rollup aggregation logic against live data.
// Runs the exact SELECTs the refresh UPSERTs and checks the totals against the
// recon baselines (REPORTS-ROLLUP-RECON.md, captured 2026-07-19). Bounds are
// monotonic lower-bounds (data only grows), so this stays green as sends land.
// No writes — does not require migration 0112 to be applied.
const ALL = sql`'-infinity'::timestamptz`;

// Recon baselines (all-time, 2026-07-19).
const BASE = {
  stageRows: 300, // ~302 distinct (stage, ET hour) buckets
  groupRows: 2000, // ~2,024
  sent: 967281,
  sales: 295,
  revenue: 20982,
  // 2,597 offer reaches on status='sent' rows. (A raw `offer_reached_at IS NOT
  // NULL` count over ALL statuses is 2,599; the rollup correctly counts only
  // sent rows — a redirect can't be attributed to a send that didn't happen.)
  offerRedirects: 2597,
};

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${name} — ${detail}`);
  if (!ok) failures++;
}

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db = drizzle(pg);
  try {
    await db.execute(sql`set statement_timeout = '40s'`);

    const a = (await db.execute(sql`
      SELECT
        count(*)::int rows,
        coalesce(sum(sent_count),0)::int sent,
        coalesce(sum(opt_out_count),0)::int optouts,
        coalesce(sum(click_count),0)::int clicks,
        coalesce(sum(offer_redirect_count),0)::int redirects,
        coalesce(sum(sales_count),0)::int sales,
        coalesce(sum(revenue),0)::numeric rev,
        coalesce(sum(cost),0)::numeric cost,
        min(bucket_hour_et)::int minh, max(bucket_hour_et)::int maxh
      FROM (${stageHourAggregate(ALL, true)}) t
    `)) as unknown as Record<string, number>[];
    const s = a[0];
    console.log("Fact A (report_stage_hour):", JSON.stringify(s));
    check("Fact A row count", s.rows >= BASE.stageRows, `rows=${s.rows} (>= ${BASE.stageRows})`);
    check("sent total", s.sent >= BASE.sent, `sent=${s.sent} (>= ${BASE.sent})`);
    check("sales total", s.sales >= BASE.sales, `sales=${s.sales} (>= ${BASE.sales})`);
    check("revenue total", Number(s.rev) >= BASE.revenue, `revenue=${s.rev} (>= ${BASE.revenue})`);
    check("offer redirects", s.redirects >= BASE.offerRedirects, `redirects=${s.redirects} (>= ${BASE.offerRedirects})`);
    check("clicks in range", s.clicks > 0 && s.clicks <= s.sent, `clicks=${s.clicks} (0 < c <= sent)`);
    check("optouts positive", s.optouts > 0, `optouts=${s.optouts}`);
    check("cost non-negative", Number(s.cost) >= 0, `cost=${s.cost}`);
    check("ET hour range valid", s.minh >= 0 && s.maxh <= 23, `hours ${s.minh}..${s.maxh}`);

    const b = (await db.execute(sql`
      SELECT count(*)::int rows, coalesce(sum(sent_count),0)::int sent
      FROM (${groupHourAggregate(ALL, true)}) t
    `)) as unknown as Record<string, number>[];
    const g = b[0];
    console.log("Fact B (report_group_hour):", JSON.stringify(g));
    check("Fact B row count", g.rows >= BASE.groupRows, `rows=${g.rows} (>= ${BASE.groupRows})`);
    // Fan-out sanity: grouped sends counted per group ⇒ Fact B sent exceeds the
    // grouped share; must be > 0 and (with avg 1.34 groups/contact) typically > A.
    check("Fact B fan-out positive", g.sent > 0, `groupSent=${g.sent} vs stageSent=${s.sent}`);

    console.log(failures === 0 ? "\nAll checks passed." : `\nFAILED: ${failures} check(s).`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
