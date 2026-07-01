// Read-only performance baseline for Tier-2 DB items. No writes.
//
//   #8 Keitaro update loops — measures ROUND-TRIP overhead: N sequential
//      point lookups by id vs one batched id = ANY($) lookup. Batching the
//      per-recipient UPDATE loop eliminates exactly these round-trips (the
//      per-row write work is unchanged; only the N-vs-1 round-trips differ).
//   #9 Missing indexes — EXPLAIN ANALYZE the queries that would use
//      keitaro_stage_results(stage_id) and campaign_audience_pool(org_id,
//      campaign_id), reporting the scan node so we can see Seq Scan -> index.
//
// Usage: npx tsx scripts/perf-baseline-tier2.ts

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;
const RUNS = 5;
const N = 200; // simulated matched-conversion count per poll

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function scanNodes(plan: Record<string, unknown>, out: string[] = []): string[] {
  if (plan["Node Type"]) out.push(String(plan["Node Type"]));
  const ch = plan["Plans"];
  if (Array.isArray(ch)) for (const c of ch) scanNodes(c as Record<string, unknown>, out);
  return out;
}

async function explain(pg: Sql, q: string, params: unknown[]) {
  const rows = (await pg.unsafe(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${q}`,
    params as never[],
  )) as unknown as Array<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown>; "Execution Time": number }> }>;
  const top = rows[0]["QUERY PLAN"][0];
  return { ms: top["Execution Time"], scans: scanNodes(top.Plan).filter((n) => /Scan/.test(n)) };
}

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });
  try {
    // ---- #8: gather N real stage_sends ids ----
    const idRows = await pg`SELECT id FROM stage_sends LIMIT ${N}`;
    const ids = idRows.map((r) => r.id as string);
    console.log("=".repeat(66));
    console.log("TIER 2 BASELINE —", new Date().toISOString());
    console.log(`#8 sample size N = ${ids.length}`);

    // N sequential point lookups (round-trip per row) — the loop pattern
    const seqTimes: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const t0 = process.hrtime.bigint();
      for (const id of ids) {
        await pg`SELECT id FROM stage_sends WHERE id = ${id}::uuid`;
      }
      seqTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    // 1 batched lookup (single round-trip) — the batched pattern
    const batchTimes: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const t0 = process.hrtime.bigint();
      await pg`SELECT id FROM stage_sends WHERE id = ANY(${ids}::uuid[])`;
      batchTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    console.log(
      `#8 loop (N sequential round-trips):  ${median(seqTimes).toFixed(1)} ms`,
    );
    console.log(
      `#8 batched (1 round-trip):           ${median(batchTimes).toFixed(1)} ms`,
    );

    // ---- #9a: keitaro_stage_results by stage_id ----
    const ksrStage = await pg`
      SELECT stage_id FROM keitaro_stage_results
      GROUP BY stage_id ORDER BY count(*) DESC LIMIT 1`;
    if (ksrStage.length) {
      const r = await explain(
        pg,
        `SELECT sum(sales) FROM keitaro_stage_results WHERE stage_id = $1`,
        [ksrStage[0].stage_id],
      );
      console.log(
        `#9a keitaro_stage_results by stage_id: ${r.ms.toFixed(2)} ms  scan: ${r.scans.join(", ")}`,
      );
    } else {
      console.log("#9a keitaro_stage_results: no rows");
    }

    // ---- #9b: campaign_audience_pool in-use join (active campaigns) ----
    const poolOrg = await pg`
      SELECT org_id FROM campaign_audience_pool
      GROUP BY org_id ORDER BY count(*) DESC LIMIT 1`;
    if (poolOrg.length) {
      const r = await explain(
        pg,
        `SELECT count(*) FROM campaign_audience_pool p
         JOIN campaigns ca ON ca.id = p.campaign_id
         WHERE ca.org_id = $1 AND ca.status = 'active'`,
        [poolOrg[0].org_id],
      );
      console.log(
        `#9b campaign_audience_pool in-use join: ${r.ms.toFixed(2)} ms  scan: ${r.scans.join(", ")}`,
      );
    } else {
      console.log("#9b campaign_audience_pool: no rows");
    }
    console.log("=".repeat(66));
  } finally {
    await pg.end({ timeout: 5 });
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
