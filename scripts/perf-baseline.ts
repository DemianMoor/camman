// Read-only performance baseline harness for the Tier-1 speed work.
//
// Measures the DB-side functionality that Tier 1 changes:
//   1. Phone search + COUNT on contacts / opt_outs / clickers (leading-wildcard ILIKE)
//   2. The <SendStateStrip> "sent today" query (non-sargable date predicate)
//
// For each query it captures BOTH the actual execution time (median of N runs)
// AND the plan's top scan node (Seq Scan vs Index Scan) — the plan is what proves
// the scaling behavior even when the current dataset is small.
//
// Read-only: only runs SELECT / EXPLAIN ANALYZE on SELECTs. No writes.
//
// Usage:
//   npx tsx scripts/perf-baseline.ts               # auto-picks the org with most contacts
//   npx tsx scripts/perf-baseline.ts <org_id>      # pin a specific org
//
// Run once BEFORE Tier 1, save the output, then again AFTER to compare.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import postgres from "postgres";

const CAMPAIGN_TIMEZONE = "America/New_York";
const RUNS = 5; // per query; report the median

type Sql = ReturnType<typeof postgres>;

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Recursively find every "Node Type" in an EXPLAIN JSON plan tree.
function collectNodeTypes(plan: Record<string, unknown>, out: string[] = []): string[] {
  if (plan["Node Type"]) out.push(String(plan["Node Type"]));
  const children = plan["Plans"];
  if (Array.isArray(children)) {
    for (const child of children) collectNodeTypes(child as Record<string, unknown>, out);
  }
  return out;
}

async function explainAnalyze(
  pg: Sql,
  query: string,
  params: unknown[],
): Promise<{ execMs: number; nodeTypes: string[] }> {
  const rows = (await pg.unsafe(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
    params as never[],
  )) as unknown as Array<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown>; "Execution Time": number }> }>;
  const top = rows[0]["QUERY PLAN"][0];
  return {
    execMs: top["Execution Time"],
    nodeTypes: collectNodeTypes(top.Plan),
  };
}

// Run a query RUNS times, return median exec time + the scan nodes seen (from run 1).
async function measure(
  pg: Sql,
  label: string,
  query: string,
  params: unknown[],
): Promise<{ label: string; medianMs: number; scans: string; runs: number[] }> {
  const times: number[] = [];
  let nodeTypes: string[] = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await explainAnalyze(pg, query, params);
    times.push(r.execMs);
    if (i === 0) nodeTypes = r.nodeTypes;
  }
  const scanNodes = nodeTypes.filter((n) => /Scan/.test(n));
  return {
    label,
    medianMs: median(times),
    scans: scanNodes.join(", ") || "(none)",
    runs: times.map((t) => Math.round(t * 100) / 100),
  };
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("Missing DATABASE_URL");
  const argOrg = process.argv[2];

  const pg = postgres(dbUrl, { prepare: false });
  const results: Array<{ label: string; medianMs: number; scans: string; runs: number[] }> = [];

  try {
    // --- Pick the org with the most contacts (or the pinned one) ---
    let orgId = argOrg;
    if (!orgId) {
      const top = await pg`
        SELECT org_id, count(*)::int AS n
        FROM contacts GROUP BY org_id ORDER BY n DESC LIMIT 1
      `;
      orgId = top[0]?.org_id as string;
    }
    if (!orgId) throw new Error("No org found with contacts");

    // --- Data volumes (overall + this org) ---
    const counts = await pg`
      SELECT
        (SELECT count(*) FROM contacts)                          AS contacts_total,
        (SELECT count(*) FROM contacts WHERE org_id = ${orgId})  AS contacts_org,
        (SELECT count(*) FROM opt_outs WHERE org_id = ${orgId})  AS opt_outs_org,
        (SELECT count(*) FROM opt_ins  WHERE org_id = ${orgId})  AS opt_ins_org,
        (SELECT count(*) FROM clickers WHERE org_id = ${orgId})  AS clickers_org,
        (SELECT count(*) FROM stage_sends WHERE org_id = ${orgId}) AS stage_sends_org
    `;
    const vol = counts[0];

    // --- Sample a real phone number substring so the search actually matches something ---
    const sample = await pg`
      SELECT phone_number FROM contacts WHERE org_id = ${orgId}
      AND length(phone_number) >= 7 LIMIT 1
    `;
    const phone = (sample[0]?.phone_number as string) ?? "5551234567";
    // middle 4 digits — a realistic "contains" search
    const mid = phone.slice(Math.max(0, Math.floor(phone.length / 2) - 2), Math.floor(phone.length / 2) + 2);
    const searchTerm = `%${mid}%`;

    console.log("=".repeat(70));
    console.log("PERF BASELINE —", new Date().toISOString());
    console.log("org_id:", orgId);
    console.log("search term (contains):", searchTerm);
    console.log("data volumes:", JSON.stringify(vol));
    console.log("=".repeat(70));

    // ============ 1. Contacts phone search — page query ============
    results.push(
      await measure(
        pg,
        "contacts search — PAGE (limit 50)",
        `SELECT id, phone_number, created_at FROM contacts
         WHERE org_id = $1 AND is_archived = false AND phone_number ILIKE $2
         ORDER BY created_at DESC LIMIT 50 OFFSET 0`,
        [orgId, searchTerm],
      ),
    );
    // ============ 2. Contacts phone search — COUNT (runs in parallel) ============
    results.push(
      await measure(
        pg,
        "contacts search — COUNT(*)",
        `SELECT count(*)::int FROM contacts
         WHERE org_id = $1 AND is_archived = false AND phone_number ILIKE $2`,
        [orgId, searchTerm],
      ),
    );
    // ============ 3. Opt-outs phone search — COUNT ============
    results.push(
      await measure(
        pg,
        "opt_outs search — COUNT(*)",
        `SELECT count(*)::int FROM opt_outs
         WHERE org_id = $1 AND phone_number ILIKE $2`,
        [orgId, searchTerm],
      ),
    );
    // ============ 4. Clickers phone search — COUNT ============
    results.push(
      await measure(
        pg,
        "clickers search — COUNT(*)",
        `SELECT count(*)::int FROM clickers
         WHERE org_id = $1 AND phone_number ILIKE $2`,
        [orgId, searchTerm],
      ),
    );
    // ============ 5. send-state "sent today" (non-sargable) — runs on EVERY page ============
    results.push(
      await measure(
        pg,
        "send-state sent_today COUNT (every page)",
        `SELECT count(*)::int AS n FROM stage_sends
         WHERE org_id = $1 AND sent_at IS NOT NULL
           AND (sent_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`,
        [orgId, CAMPAIGN_TIMEZONE],
      ),
    );

    // --- Report ---
    console.log("\nRESULTS (median of", RUNS, "runs):\n");
    console.log(
      "| Query | Median ms | Scan node(s) | All runs (ms) |",
    );
    console.log("|---|---:|---|---|");
    for (const r of results) {
      console.log(
        `| ${r.label} | ${r.medianMs.toFixed(2)} | ${r.scans} | ${r.runs.join(", ")} |`,
      );
    }
    console.log(
      "\nNOTE: 'Seq Scan' on a filtered table = will degrade as rows grow.",
    );
    console.log("      'Index Scan / Bitmap Index Scan' = index-served.\n");
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("perf-baseline FAILED:", err);
  process.exit(1);
});
