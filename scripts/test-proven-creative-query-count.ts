// RUN WITH: npx tsx --conditions=react-server scripts/test-proven-creative-query-count.ts
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  isProven,
  loadCreativeSendHistory,
} from "@/lib/guardrails/proven-creative";

// Proves the property the Prepare path depends on: the proven-creative history
// query executes ONCE, and answering "is creative N proven" afterwards costs no
// further queries.
//
// ⚠️ THIS IS THE TEST THAT STOPS A 15-SECOND PREPARE. The joined query costs
// ~1.0-1.2s (recon §7). Called once per stage instead of once per Prepare, a
// twelve-lane campaign would run it twelve times inside a request a human is
// waiting on. Nothing in the type system prevents someone "tidying" the loader
// into the per-stage branch, so the count is asserted rather than trusted to a
// comment.
//
// Counted via pg_stat_statements, which is installed on this database. The
// statement is matched on a fragment unique to this query.

let failures = 0;
const ok = (m: string) => console.log(`  OK ${m}`);
const bad = (m: string) => {
  console.log(`  XX ${m}`);
  failures++;
};

// ⚠️ MATCH ON A FRAGMENT THAT SURVIVES NORMALIZATION. pg_stat_statements
// replaces literals with $n, so 'America/New_York' becomes $3 and a pattern
// containing it matches NOTHING — the first version of this test reported
// "0 executions" for a query that had definitely run. `et_day` is an alias, not
// a literal, so it survives.
const FRAGMENT = "%et_day%";

async function callCount(): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT coalesce(sum(calls), 0)::int AS calls
    FROM pg_stat_statements
    WHERE query LIKE ${FRAGMENT}
      AND query LIKE '%cs.creative_id%'
  `)) as unknown as { calls: number }[];
  return rows[0]?.calls ?? 0;
}

async function main() {
  console.log("=== proven-creative query count ===\n");

  const available = (await db.execute(sql`
    SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pg_stat_statements'
  `)) as unknown as { n: number }[];
  if ((available[0]?.n ?? 0) === 0) {
    bad("pg_stat_statements is NOT installed — cannot count executions");
    process.exit(1);
  }
  ok("pg_stat_statements is available");

  const [org] = (await db.execute(sql`
    SELECT id::text AS id FROM organizations LIMIT 1
  `)) as unknown as { id: string }[];
  if (!org) {
    bad("no organization found — EMPTY scope");
    process.exit(1);
  }

  const before = await callCount();
  console.log(`  scope: baseline call count for the history query = ${before}`);

  // ONE Prepare's worth of work: load once, then answer for every creative.
  const history = await loadCreativeSendHistory(org.id);
  const creativeIds = [...history.keys()];
  console.log(`  loaded history for ${creativeIds.length} creative(s)`);

  let proven = 0;
  for (const id of creativeIds) if (isProven(history, id)) proven++;
  // Answer for creatives with no history too — the map read must not query.
  for (let i = 0; i < 50; i++) isProven(history, 10_000_000 + i);

  const after = await callCount();
  const delta = after - before;
  console.log(`  scope: ${creativeIds.length} creatives resolved + 50 misses, delta = ${delta}`);

  if (creativeIds.length === 0) {
    console.log("  !  history is EMPTY — the count below still proves the loader ran once,");
    console.log("     but the per-creative reads were not exercised against real data.");
  }

  if (delta === 1) {
    ok(`exactly ONE execution for ${creativeIds.length} creatives + 50 misses`);
  } else {
    bad(`expected exactly 1 execution, saw ${delta} — the loader is being called per creative`);
  }
  console.log(`     proven creatives in the window: ${proven}`);

  // And a direct check on the shape: isProven must be synchronous, so it
  // cannot be issuing a query at all.
  const isSync = isProven.constructor.name !== "AsyncFunction";
  if (isSync) ok("isProven is synchronous — structurally cannot query");
  else bad("isProven is async — it may be querying per creative");

  console.log(`\n=== ${failures === 0 ? "ALL PASS" : "FAILURES"} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("threw:", e instanceof Error ? e.message : e);
  process.exit(1);
});
