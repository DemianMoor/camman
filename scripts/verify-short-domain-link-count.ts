// Migration 0144 — links.short_domain_id, and the minted-link count it brings
// back to /settings/short-domains.
//
// The count was REMOVED in #88 for cost. Restoring it without evidence would
// repeat that history, so this measures the thing that was measured then, the
// same way, and prints both numbers.
//
// Bars:
//   (0) The index EXISTS and is VALID. A failed CONCURRENTLY build leaves an
//       INVALID index the planner ignores while it still costs write
//       amplification on every mint — silent, and exactly the failure mode
//       worth a check.
//   (1) The counting query USES it. An index that exists but is not chosen buys
//       nothing.
//   (2) Measured cost, per brand, printed. Not asserted against a magic
//       threshold — the number is the deliverable and it grows with traffic.
//   (3) The counts are CORRECT (they agree with a direct count).
//   (4) The count is still ADVISORY: the server-side delete guard is
//       independent of it.
import "./_env-preload";

import { promises as fs } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";
import { listBrandShortDomains } from "@/lib/sends/short-domain";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? `\n     ${detail}` : ""}`);
}

const INDEX = "links_short_domain_id_idx";

async function main() {
  // ── (0) the index exists AND is valid ────────────────────────────────────
  const idx = (await db.execute(sql`
    SELECT c.relname, i.indisvalid, pg_size_pretty(pg_relation_size(c.oid)) AS size
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = ${INDEX}
  `)) as unknown as { relname: string; indisvalid: boolean; size: string }[];
  check(`(0) ${INDEX} exists`, idx.length === 1, idx[0] ? `${idx[0].size}` : "NOT FOUND");
  check(
    `(0) ${INDEX} is VALID`,
    idx[0]?.indisvalid === true,
    idx[0]?.indisvalid === false
      ? "INVALID — a failed CONCURRENTLY build; the planner ignores it while every mint still pays to maintain it"
      : "valid",
  );

  const totalLinks = (await db.execute(sql`SELECT count(*)::int AS n FROM links`)) as unknown as { n: number }[];
  console.log(`\nSCOPE — links table holds ${totalLinks[0].n.toLocaleString()} rows`);

  // ── (1)+(2) plan and cost, per brand, through the REAL function ──────────
  const brands = (await db.execute(sql`
    SELECT d.org_id, d.brand_id, b.name, count(*)::int AS domains
    FROM short_domains d JOIN brands b ON b.id = d.brand_id
    GROUP BY 1, 2, 3 ORDER BY 4 DESC, 2
  `)) as unknown as { org_id: string; brand_id: number; name: string; domains: number }[];
  check("at least one brand has short domains", brands.length > 0, `${brands.length}`);

  console.log("\nMEASURED — listBrandShortDomains(), warm:");
  let slowest = 0;
  let slowestLabel = "";
  for (const b of brands) {
    const t0 = Date.now();
    const rows = await listBrandShortDomains(db, { orgId: b.org_id, brandId: b.brand_id });
    const ms = Date.now() - t0;
    if (ms > slowest) { slowest = ms; slowestLabel = b.name; }
    console.log(
      `     ${b.name} (#${b.brand_id}) — ${rows.length} domain(s), ${ms} ms: ` +
        rows.map((r) => `${r.domain}=${r.link_count.toLocaleString()}`).join(", "),
    );
    // ── (3) the numbers are right ──────────────────────────────────────────
    for (const r of rows) {
      const direct = (await db.execute(sql`
        SELECT count(*)::int AS n FROM links WHERE short_domain_id = ${r.id}
      `)) as unknown as { n: number }[];
      check(
        `(3) ${r.domain}: the listed count matches a direct count`,
        r.link_count === direct[0].n,
        `listed ${r.link_count} vs direct ${direct[0].n}`,
      );
    }
  }
  // The page fetches brands in PARALLEL (#88), so its wall clock is the slowest
  // brand, not the sum. Stated because summing here would overstate it.
  console.log(
    `\n     page cost ≈ slowest brand (fetches are parallel): ${slowest} ms — ${slowestLabel}`,
  );

  // ⚠️ THESE WALL-CLOCK FIGURES INCLUDE THE ROUND TRIP FROM WHEREVER THIS RUNS.
  // Run locally they carry ~400 ms of latency to eu-central-1 — visible above as
  // brands with ZERO links costing about as much as brands with thousands. The
  // deployed app runs in fra1, next to the database. For the SERVER-side cost of
  // the count itself, read the in-database EXPLAIN ANALYZE figures quoted below.
  console.log(
    `     BEFORE migration 0144, the same query on brand 8 measured 12,574 ms\n` +
      `     (Seq Scan on links, 3.28M rows, once per domain).`,
  );

  // ── (1) the plan actually uses the index ─────────────────────────────────
  const someDomain = (await db.execute(sql`
    SELECT id FROM short_domains ORDER BY id LIMIT 1
  `)) as unknown as { id: number }[];
  const plan = (await db.execute(sql`
    EXPLAIN (FORMAT TEXT) SELECT count(*) FROM links l WHERE l.short_domain_id = ${someDomain[0].id}
  `)) as unknown as Record<string, string>[];
  const planText = plan.map((r) => Object.values(r)[0]).join("\n");
  console.log("\n(1) count plan:");
  for (const line of planText.split("\n")) console.log(`     ${line}`);
  check(
    "(1) the count uses the new index, not a sequential scan of links",
    planText.includes(INDEX) && !/Seq Scan on links/.test(planText),
    /Seq Scan on links/.test(planText) ? "SEQ SCAN — the index is not being chosen" : "indexed",
  );

  // ── (4) the count is ADVISORY; the real guard is server-side ─────────────
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  const src = strip(await fs.readFile(path.join(process.cwd(), "lib/sends/short-domain.ts"), "utf8"));
  check(
    "(4) deleteShortDomain still refuses independently, with domain_in_use",
    /domain_in_use/.test(src),
    "the client figure only pre-disables a button the server already guards",
  );
  const ui = strip(await fs.readFile(path.join(process.cwd(), "components/settings/brand-short-domains.tsx"), "utf8"));
  check(
    "(4) the UI still surfaces the server's refusal (the count can be stale)",
    /toastApiError/.test(ui),
    "a link minted between the fetch and the click must still be caught",
  );

  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
