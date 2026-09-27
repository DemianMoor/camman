import "./_env-preload";

// WHAT THE LIFECYCLE REPORT COSTS, AND WHAT IT SAYS — read-only, production.
//
// The report reads per-recipient rows rather than a rollup, so its cost is the
// thing to know before anyone opens the tab. Windows are run smallest-first and
// the run STOPS at the first window over the budget, so a 92-day probe cannot
// be the thing that makes the page slow for the owner.
//
// Read-only: one SELECT per window, no writes, no temp tables.
//
// Run: npx tsx --conditions=react-server scripts/measure-lifecycle-report.ts
//      npx tsx --conditions=react-server scripts/measure-lifecycle-report.ts --days 1,7,30

const BUDGET_MS = 25_000;

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

async function main() {
  const { db } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");
  const { getLifecycleReport, lifecycleReportSql } = await import(
    "@/lib/reporting/lifecycle-report"
  );
  const { formatInCampaignTimezone } = await import("@/lib/campaign-timezone");

  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x")
    .hostname;
  console.log(`read-only against ${host}\n`);

  const orgs = (await db.execute(
    sql`SELECT id FROM organizations ORDER BY created_at`,
  )) as unknown as { id: string }[];
  if (orgs.length !== 1) throw new Error(`${orgs.length} orgs — assumes one`);
  const orgId = orgs[0].id;

  const windows = (arg("days") ?? "1,7,30,92").split(",").map(Number);
  const day = (n: number) =>
    formatInCampaignTimezone(new Date(Date.now() - n * 86_400_000), "yyyy-MM-dd");

  for (const w of windows) {
    const t0 = performance.now();
    const rep = await getLifecycleReport({
      orgId,
      from: day(w - 1),
      to: day(0),
    });
    const ms = performance.now() - t0;
    const total = rep.rows.find((r) => r.row === "total")!;
    const unclass = rep.rows.find((r) => r.row === "unclassified")!;
    console.log(
      `${String(w).padStart(3)}d  ${String(Math.round(ms)).padStart(6)} ms  ` +
        `total ${total.sends.toLocaleString().padStart(9)} sends  ` +
        `unclassified ${unclass.sends.toLocaleString().padStart(9)}  ` +
        `reconstructed ${rep.has_reconstructed}`,
    );
    for (const r of rep.rows) {
      if (r.sends === 0 && r.row !== "suppressed") continue;
      console.log(
        `        ${r.row.padEnd(13)} sends ${r.sends.toLocaleString().padStart(9)}  ` +
          `clickers ${r.clickers.toLocaleString().padStart(7)}  ` +
          `ctr ${r.ctr === null ? "    —" : (r.ctr * 100).toFixed(2) + "%"}  ` +
          `sales ${String(r.sales).padStart(5)}  ` +
          `cr ${r.cr === null ? "    —" : (r.cr * 100).toFixed(2) + "%"}  ` +
          `rev $${Number(r.revenue).toFixed(2).padStart(10)}  ` +
          `optout ${r.opt_out_rate === null ? "    —" : (r.opt_out_rate * 100).toFixed(2) + "%"}  ` +
          `cost $${Number(r.cost).toFixed(2).padStart(9)}`,
      );
    }
    console.log("");
    // ⚠️ STOP, do not carry on to the bigger window. The next one is strictly
    // more expensive, and the point of a budget nobody enforces is nothing.
    if (ms > BUDGET_MS) {
      console.log(
        `STOPPING: ${Math.round(ms)} ms at ${w}d is over the ${BUDGET_MS / 1000}s budget; ` +
          `larger windows not run.`,
      );
      break;
    }
  }

  // --explain: the plan for the REAL statement, not a re-typed copy of it.
  if (process.argv.includes("--explain")) {
    const w = Number(arg("explain-days") ?? "7");
    console.log(`EXPLAIN (ANALYZE, BUFFERS) over ${w}d`);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '180s'`);
      const plan = (await tx.execute(sql`
        EXPLAIN (ANALYZE, BUFFERS, SETTINGS)
        ${lifecycleReportSql({ orgId, from: day(w - 1), to: day(0) })}`)) as unknown as
        Record<string, string>[];
      for (const r of plan) console.log(Object.values(r)[0]);
      throw new Error("__ROLLBACK__");
    }).catch((e) => {
      if (!(e instanceof Error) || e.message !== "__ROLLBACK__") throw e;
    });
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
