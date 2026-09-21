import { config } from "dotenv"; import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

// Exercises the shared stage-funnel against real data for a CLOSED historical
// window (Jul 18-19 2026) and checks that per-stage metrics still foot to the
// grand totals.
//
// ⚠️ WHAT THIS ASSERTS, AND WHY THE MONEY BARS WERE RETIRED (2026-09-18, Phase 3
// Task 6 review I3). It used to carry four "data only grows" floors read off an
// Overview screenshot — clickers >= 2144, redirect >= 257, sales >= 32,
// revenue >= 2040 — under the comment "Data only grows."
//
// Two of those are still true and two are not:
//   • CLICK columns (clickers, offer redirects) are written by the Keitaro
//     AGGREGATE poll and are untouched by the ledger switch, so a closed past
//     window can only accumulate. They stay, as floors, with their world-state
//     named: the numbers are from the Overview screenshot dated Jul 20 2026.
//   • SALES and REVENUE are now re-derived from the conversion_events ledger
//     (Phase 3): revenue counts APPROVED conversions only, a rejected conversion
//     is no longer a sale, and bug 2's double-counted re-dated conversions are
//     removed. All three corrections move a historical window DOWNWARDS. A
//     `>=` floor on them is a bar that goes red precisely when the change works,
//     which is the one failure mode nobody reads correctly during a cutover. It
//     is RETIRED, not re-pointed at a new number: any figure picked today is a
//     snapshot of a world that is about to move again (the prod backfill), and
//     re-pinning it would just reset the countdown.
//
// The money side is still EXERCISED — it is printed, and it must foot: the sum
// of the per-stage sales equals the grand total (`eq` below), which is the
// structural property the funnel actually owns, and it is direction-free.
async function main() {
  const { db } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");
  const { getStageMetricsInRange } = await import("@/lib/reporting/stage-funnel");
  const { requirePendingRevenueColumn } = await import("./_require-migration");
  // NEEDS MIGRATION 0182 (same reason as verify-epc-denominator): the funnel
  // selects keitaro_stage_results.pending_revenue. Say so, instead of dying on a
  // raw 42703 that reads like a broken report.
  await requirePendingRevenueColumn(db, "test-stage-funnel");
  const orgRows = (await db.execute(sql`select org_id from campaigns limit 1`)) as any[];
  const orgId = orgRows[0].org_id as string;

  const { stages, grand, grandOptOuts, grandTotalSent } = await getStageMetricsInRange(orgId, "2026-07-18", "2026-07-19");
  const clickers = grand.visit_clicks_clean, redirect = grand.redirect_clicks_clean;
  console.log("GRAND Jul18-19:", JSON.stringify({
    clickers, redirect, sales: grand.sales, revenue: grand.revenue.toFixed(2),
    cost: grand.cost.toFixed(2), profit: (grand.revenue - grand.cost).toFixed(2),
    opt_outs: grandOptOuts, total_sent: grandTotalSent,
    opt_out_pct: grandTotalSent ? (grandOptOuts / grandTotalSent * 100).toFixed(1) + "%" : "0",
    stages: stages.length,
  }));

  // CLICK floors only. World-state: the Overview screenshot "Data as of Jul 20
  // 2026", for the closed window Jul 18-19. These two columns come from the
  // Keitaro aggregate poll, which the Phase 3 ledger switch does not touch, so
  // they can only accumulate. The sales/revenue floors that used to sit here are
  // retired — see the header.
  const base = { clickers: 2144, redirect: 257 };
  let fail = 0;
  // ⚠️ THE FLOORS ARE PROD BARS AND THEY NAME THEIR WORLD. On a database with no
  // rows in the window (camman-v2 has none) a floor measures the DATABASE'S
  // POPULATION, not the funnel — 0 >= 2144 would read as a catastrophic
  // regression when nothing is wrong. Say which of the two it is; the run still
  // fails, because an empty window is not a verification either.
  const emptyWindow = stages.length === 0;
  if (emptyWindow) {
    console.log("  ! EMPTY WINDOW on this database — the floors below are PROD bars and cannot be evaluated here.");
    console.log("    Expected on camman-v2 (it holds no historical Keitaro rows). A RED FLAG on prod.");
  }
  const chk = (n: string, v: number, min: number) => {
    if (emptyWindow) { console.log(`  · ${n}=${v} (floor ${min} SKIPPED — empty window)`); return; }
    const ok = v >= min; console.log(`  ${ok?"✓":"✗"} ${n}=${v} (>= ${min})`); if(!ok) fail++;
  };
  chk("clickers", clickers, base.clickers);
  chk("redirect", redirect, base.redirect);
  // Reported, never asserted: approved-only revenue and the de-duplicated sale
  // count may legitimately read LOWER than any figure recorded before the switch.
  console.log(`  · sales=${grand.sales} revenue=${grand.revenue.toFixed(2)} (reported, not asserted — approved-only, see header)`);

  // Additivity: summing stage metrics by any stage-level dimension must equal grand.
  const sumSent = stages.reduce((a,s)=>a+s.total_sent,0);
  const sumClickers = stages.reduce((a,s)=>a+s.tally.visit_clicks_clean,0);
  const sumSales = stages.reduce((a,s)=>a+s.tally.sales,0);
  const sumOpt = stages.reduce((a,s)=>a+s.opt_outs,0);
  const sumRevenue = stages.reduce((a,s)=>a+s.tally.revenue,0);
  const sumPending = stages.reduce((a,s)=>a+s.tally.pending_revenue,0);
  console.log("SUM(stages):", JSON.stringify({ sent: sumSent, clickers: sumClickers, sales: sumSales, opt: sumOpt, revenue: sumRevenue.toFixed(2), pending: sumPending.toFixed(2) }));
  const eq = (n: string, a: number, b: number) => { const ok = a===b; console.log(`  ${ok?"✓":"✗"} sum ${n} ${a} == grand ${b}`); if(!ok) fail++; };
  eq("clickers", sumClickers, clickers);
  eq("sales", sumSales, grand.sales);
  eq("opt_outs", sumOpt, grandOptOuts);
  eq("total_sent", sumSent, grandTotalSent);
  // The money's structural bar, replacing the retired floors: whatever the
  // approved-only total turns out to be, the stages must still foot to it, and
  // held money must foot separately — it is never folded into revenue.
  const eqMoney = (n: string, a: number, b: number) => { const ok = Math.abs(a-b) < 0.005; console.log(`  ${ok?"✓":"✗"} sum ${n} ${a.toFixed(4)} == grand ${b.toFixed(4)}`); if(!ok) fail++; };
  eqMoney("revenue", sumRevenue, grand.revenue);
  eqMoney("pending_revenue", sumPending, grand.pending_revenue);

  if (emptyWindow) { console.log(`\nNOT A VERIFICATION — the window is empty on this database (${fail} structural check(s) failed).`); process.exit(1); }
  console.log(fail===0 ? "\nAll checks passed." : `\nFAILED: ${fail}`);
  process.exit(fail===0?0:1);
}
main().catch(e=>{console.error(e);process.exit(1);});
