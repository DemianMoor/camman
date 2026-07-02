// Read-only baseline for Tier-3 item #12 (keyset vs OFFSET pagination) on the
// large contacts table. Measures how the default list query degrades as the
// user pages deeper (OFFSET scans+discards all preceding rows), plus the
// always-on unfiltered COUNT(*). No writes.
//
// Usage: npx tsx scripts/perf-baseline-tier3.ts

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;
const RUNS = 5;
const PAGE = 50;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function scans(p: Record<string, unknown>, out: string[] = []): string[] {
  if (p["Node Type"]) out.push(String(p["Node Type"]));
  const ch = p["Plans"];
  if (Array.isArray(ch)) for (const c of ch) scans(c as Record<string, unknown>, out);
  return out;
}
async function measure(pg: Sql, label: string, q: string, params: unknown[]) {
  const times: number[] = [];
  let nodes: string[] = [];
  for (let i = 0; i < RUNS; i++) {
    const r = (await pg.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${q}`, params as never[])) as unknown as Array<{
      "QUERY PLAN": Array<{ Plan: Record<string, unknown>; "Execution Time": number }>;
    }>;
    times.push(r[0]["QUERY PLAN"][0]["Execution Time"]);
    if (i === 0) nodes = scans(r[0]["QUERY PLAN"][0].Plan).filter((n) => /Scan/.test(n));
  }
  console.log(`| ${label} | ${median(times).toFixed(1)} | ${nodes.join(", ")} |`);
}

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });
  try {
    const org = (await pg`SELECT org_id FROM contacts GROUP BY org_id ORDER BY count(*) DESC LIMIT 1`)[0]
      .org_id as string;
    const total = (await pg`SELECT count(*)::int AS n FROM contacts WHERE org_id = ${org} AND is_archived = false`)[0]
      .n as number;
    console.log("=".repeat(66));
    console.log("TIER 3 BASELINE (item #12 pagination) —", new Date().toISOString());
    console.log("org active contacts:", total);
    console.log("=".repeat(66));
    console.log("| Query | Median ms | Scan node(s) |");
    console.log("|---|---:|---|");

    // Unconditional COUNT(*) that every list request runs alongside the page.
    await measure(
      pg,
      "unfiltered COUNT(*)",
      `SELECT count(*)::int FROM contacts WHERE org_id = $1 AND is_archived = false`,
      [org],
    );

    // OFFSET pagination at increasing depth (the real page query shape).
    const pageQ = `SELECT id, phone_number, created_at FROM contacts
      WHERE org_id = $1 AND is_archived = false
      ORDER BY created_at DESC, id DESC LIMIT ${PAGE} OFFSET $2`;
    for (const off of [0, 1000, 10000, 100000, Math.max(0, total - PAGE)]) {
      await measure(pg, `OFFSET page @ offset ${off}`, pageQ, [org, off]);
    }

    // Keyset equivalent for the DEEPEST page — what #12 would replace OFFSET with.
    // Grab the (created_at,id) cursor at the deep boundary, then range-scan past it.
    const deepOff = Math.max(0, total - PAGE * 2);
    const cursor = (await pg.unsafe(
      `SELECT created_at, id FROM contacts WHERE org_id = $1 AND is_archived = false
       ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET $2`,
      [org, deepOff] as never[],
    )) as unknown as Array<{ created_at: string; id: number }>;
    if (cursor.length) {
      await measure(
        pg,
        `KEYSET page @ same depth (cursor)`,
        `SELECT id, phone_number, created_at FROM contacts
         WHERE org_id = $1 AND is_archived = false
           AND (created_at, id) < ($2::timestamptz, $3::int)
         ORDER BY created_at DESC, id DESC LIMIT ${PAGE}`,
        [org, cursor[0].created_at, cursor[0].id],
      );
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
