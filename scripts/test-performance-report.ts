import { config } from "dotenv"; import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const { db } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");
  const { getPerformanceReport } = await import("@/lib/reporting/performance-report");
  const { getStageMetricsInRange } = await import("@/lib/reporting/stage-funnel");
  const orgId = ((await db.execute(sql`select org_id from campaigns limit 1`)) as any[])[0].org_id as string;

  const from = "2026-07-18", to = "2026-07-19";
  const { grand, grandTotalSent, grandOptOuts } = await getStageMetricsInRange(orgId, from, to);
  const ref = { sent: grandTotalSent, opt: grandOptOuts, clickers: grand.visit_clicks_clean, redirects: grand.redirect_clicks_clean, sales: grand.sales, revenue: Math.round(grand.revenue) };
  console.log("Overview grand:", JSON.stringify(ref));

  let fail = 0;
  const near = (a: number, b: number, eps = 0.5) => Math.abs(a - b) <= eps;

  for (const dim of ["number", "offer", "sequence", "group"] as const) {
    const r = await getPerformanceReport(orgId, dim, { from, to, providerPhoneId: null });
    const sum = r.rows.reduce((a: any, x: any) => ({
      sent: a.sent + x.sent, opt: a.opt + x.opt_outs, clickers: a.clickers + x.clickers,
      redirects: a.redirects + x.redirects, sales: a.sales + x.sales, revenue: a.revenue + x.revenue,
    }), { sent: 0, opt: 0, clickers: 0, redirects: 0, sales: 0, revenue: 0 });
    // totals must equal Overview grand
    const tOK = r.totals.sent === ref.sent && r.totals.clickers === ref.clickers && r.totals.sales === ref.sales && Math.round(r.totals.revenue) === ref.revenue;
    console.log(`${dim.padEnd(9)} rows=${r.rows.length} totals{sent:${r.totals.sent},clk:${r.totals.clickers},sales:${r.totals.sales},rev:${Math.round(r.totals.revenue)}} sumRows{sent:${sum.sent.toFixed(1)},clk:${sum.clickers.toFixed(1)},sales:${sum.sales.toFixed(1)}}`);
    if (!tOK) { console.log(`  x ${dim} totals != Overview grand`); fail++; }
    // rows reconcile to totals (exact for stage dims, ~ for group due to rounding)
    const eps = dim === "group" ? 2 : 0.001;
    if (!near(sum.sent, ref.sent, eps) || !near(sum.clickers, ref.clickers, eps) || !near(sum.sales, ref.sales, eps)) {
      console.log(`  x ${dim} rows don't reconcile to grand (sent ${sum.sent} vs ${ref.sent}, clk ${sum.clickers} vs ${ref.clickers}, sales ${sum.sales} vs ${ref.sales})`); fail++;
    }
    if (r.rows.length === 0) { console.log(`  x ${dim} no rows`); fail++; }
  }

  // hourly: single day, activity-time
  const h = await getPerformanceReport(orgId, "hourly", { from: "2026-07-18", to: "2026-07-18", providerPhoneId: null });
  console.log(`hourly rows=${h.rows.length} totals{clk:${h.totals.clickers},sales:${h.totals.sales},opt:${h.totals.opt_outs}}`);
  console.log("  hours:", h.rows.map((r: any) => `${r.label}${r.pinned?"*":""}:clk${r.clickers}/opt${r.opt_outs}`).join("  "));

  console.log(fail === 0 ? "\nAll checks passed." : `\nFAILED: ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
