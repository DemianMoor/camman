import { config } from "dotenv"; import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const { db } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");
  const { getStageMetricsInRange } = await import("@/lib/reporting/stage-funnel");
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

  // Baselines from the Overview screenshot (Data as of Jul 20). Data only grows.
  const base = { clickers: 2144, redirect: 257, sales: 32, revenue: 2040 };
  let fail = 0;
  const chk = (n: string, v: number, min: number) => { const ok = v >= min; console.log(`  ${ok?"✓":"✗"} ${n}=${v} (>= ${min})`); if(!ok) fail++; };
  chk("clickers", clickers, base.clickers);
  chk("redirect", redirect, base.redirect);
  chk("sales", grand.sales, base.sales);
  chk("revenue", Math.round(grand.revenue), base.revenue);

  // Additivity: summing stage metrics by any stage-level dimension must equal grand.
  const sumSent = stages.reduce((a,s)=>a+s.total_sent,0);
  const sumClickers = stages.reduce((a,s)=>a+s.tally.visit_clicks_clean,0);
  const sumSales = stages.reduce((a,s)=>a+s.tally.sales,0);
  const sumOpt = stages.reduce((a,s)=>a+s.opt_outs,0);
  console.log("SUM(stages):", JSON.stringify({ sent: sumSent, clickers: sumClickers, sales: sumSales, opt: sumOpt }));
  const eq = (n: string, a: number, b: number) => { const ok = a===b; console.log(`  ${ok?"✓":"✗"} sum ${n} ${a} == grand ${b}`); if(!ok) fail++; };
  eq("clickers", sumClickers, clickers);
  eq("sales", sumSales, grand.sales);
  eq("opt_outs", sumOpt, grandOptOuts);
  eq("total_sent", sumSent, grandTotalSent);

  console.log(fail===0 ? "\nAll checks passed." : `\nFAILED: ${fail}`);
  process.exit(fail===0?0:1);
}
main().catch(e=>{console.error(e);process.exit(1);});
