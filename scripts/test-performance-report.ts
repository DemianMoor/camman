import { config } from "dotenv"; import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const { db } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");
  const { getPerformanceReport } = await import("@/lib/reporting/performance-report");
  const { getStageMetricsInRange } = await import("@/lib/reporting/stage-funnel");
  const orgId = ((await db.execute(sql`select org_id from campaigns limit 1`)) as unknown as { org_id: string }[])[0].org_id;

  const from = "2026-07-18", to = "2026-07-19";
  const { grand, grandTotalSent, grandOptOuts } = await getStageMetricsInRange(orgId, from, to);
  const ref = { sent: grandTotalSent, opt: grandOptOuts, clickers: grand.visit_clicks_clean, redirects: grand.redirect_clicks_clean, sales: grand.sales, revenue: Math.round(grand.revenue) };
  console.log("Overview grand:", JSON.stringify(ref));

  let fail = 0;
  const near = (a: number, b: number, eps = 0.5) => Math.abs(a - b) <= eps;

  // ⚠️ THIS IS A PROD SCRIPT AND IT MUST SAY SO WHEN IT IS NOT ON PROD. The
  // window Jul 18-19 2026 is empty on camman-v2 (no historical Keitaro rows), and
  // an empty window turns every reconciliation below into 0 == 0 while the "no
  // rows" check fires four times — which reads like four regressions and is
  // neither. The run still fails: an empty window is not a verification either.
  const emptyWindow = ref.sent === 0 && ref.clickers === 0 && ref.sales === 0;
  if (emptyWindow) {
    console.log("  ! EMPTY WINDOW on this database — the reconciliations below cannot be evaluated here.");
    console.log("    Expected on camman-v2 (it holds no historical Keitaro rows). A RED FLAG on prod.");
    console.log("    Phase 5's per-event columns are proved on a world of their own by");
    console.log("    scripts/test-report-event-columns-db.ts, which runs on camman-v2.");
  }

  // Phase 5: the per-event breakdown must reconcile the same way the scalars do —
  // every dimension's rows must sum, per KEY, to its totals. Vacuous on an empty
  // window (see above); non-vacuously proved by test-report-event-columns-db.
  const eventKeyTotals = (rows: { events: Record<string, { n: number }> }[]) => {
    const out: Record<string, number> = {};
    for (const r of rows) for (const [k, t] of Object.entries(r.events ?? {})) out[k] = (out[k] ?? 0) + t.n;
    return out;
  };

  for (const dim of ["number", "offer", "sequence", "group"] as const) {
    const r = await getPerformanceReport(orgId, dim, { from, to, providerPhoneId: null });
    const sum = r.rows.reduce((a, x) => ({
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
    if (r.rows.length === 0 && !emptyWindow) { console.log(`  x ${dim} no rows`); fail++; }
    // Per-event reconciliation, per key. By Group is fractionally split and
    // round2'd per row, so it gets the same loose epsilon the scalars get.
    const rowEv = eventKeyTotals(r.rows);
    const totEv = eventKeyTotals([r.totals]);
    const evEps = dim === "group" ? 2 : 0.001;
    const evKeys = [...new Set([...Object.keys(rowEv), ...Object.keys(totEv)])];
    console.log(`  events ${JSON.stringify(totEv)} unmapped=${r.totals.unmapped} manual_topup=${r.totals.manual_topup}`);
    for (const k of evKeys) {
      if (!near(rowEv[k] ?? 0, totEv[k] ?? 0, evEps)) {
        console.log(`  x ${dim} events[${k}] rows ${rowEv[k] ?? 0} != totals ${totEv[k] ?? 0}`); fail++;
      }
    }
    if (!near(r.rows.reduce((a, x) => a + x.unmapped, 0), r.totals.unmapped, evEps)) {
      console.log(`  x ${dim} unmapped rows != totals`); fail++;
    }
    if (!near(r.rows.reduce((a, x) => a + x.manual_topup, 0), r.totals.manual_topup, evEps)) {
      console.log(`  x ${dim} manual_topup rows != totals`); fail++;
    }
  }

  // hourly: single day, activity-time
  const h = await getPerformanceReport(orgId, "hourly", { from: "2026-07-15", to: "2026-07-19", providerPhoneId: null });
  console.log(`hourly rows=${h.rows.length} totals{sent:${h.totals.sent},clk:${h.totals.clickers},sales:${h.totals.sales},opt:${h.totals.opt_outs}} CR=${h.totals.sent?(h.totals.clickers/h.totals.sent*100).toFixed(1):0}%`);
  console.log("  hours:", h.rows.map((r) => `${r.label}${r.pinned?"*":""}:sent${r.sent}/clk${r.clickers}/opt${r.opt_outs}`).join("  "));

  if (emptyWindow) {
    console.log(`\nNOT A VERIFICATION — the window is empty on this database (${fail} structural check(s) failed).`);
    process.exit(1);
  }
  console.log(fail === 0 ? "\nAll checks passed." : `\nFAILED: ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
