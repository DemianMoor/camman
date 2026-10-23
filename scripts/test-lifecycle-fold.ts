import "./_env-preload";

// THE LIFECYCLE REPORT'S ROW ARITHMETIC — pure, no database.
//
// foldLifecycleRows turns the per-cohort cells the query (or the rollup)
// returns into the rows the page prints. Every derived row is a SUM of named
// cells, so a wrong key list is a silently wrong total rather than an error —
// which is exactly what the 2026-10-23 audit found: Total omitted the
// Unclassified row and read $24,575 of a $29,226 period. These bars pin each
// derived row to the cells it must contain, on every summed column.
//
// Run: npx tsx --conditions=react-server scripts/test-lifecycle-fold.ts

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

async function main() {
  const { foldLifecycleRows } = await import("@/lib/reporting/lifecycle-report");

  // Distinct, non-overlapping magnitudes per cell, so a sum that drops or
  // double-counts a cell lands on a different number.
  const cell = (
    row: string,
    k: number,
    opts: { cost?: number; revenue?: number; kind?: "regular" | "drip"; newClickers?: number } = {},
  ) => ({
    kind: opts.kind ?? ("regular" as const),
    row,
    sends: 1000 * k,
    clickers: 100 * k,
    new_clickers: opts.newClickers ?? 3 * k,
    sales: 10 * k,
    purchases: 11 * k,
    revenue: String(opts.revenue ?? 5 * k),
    opt_outs: k,
    cost: String(opts.cost ?? 2 * k),
    reconstructed: false,
  });
  const rows = [
    cell("new", 1),
    cell("cold", 2),
    cell("hot", 3),
    cell("warm", 4),
    cell("freeze", 5),
    // suppressed absent — a missing cell must read as zero, not break the sum.
    cell("__unclassified__", 7),
    // Drip cells — stamped (cold) and unstamped. Neither may reach a cohort row.
    cell("cold", 8, { kind: "drip" }),
    cell("__unclassified__", 9, { kind: "drip" }),
  ];
  const rep = foldLifecycleRows(rows, "2026-09-23", "2026-10-22");
  const r = (k: string) => {
    const x = rep.rows.find((y) => y.row === k);
    if (!x) throw new Error(`row ${k} missing`);
    return x;
  };
  const sumOf = (ks: number[]) => ks.reduce((a, b) => a + b, 0);

  console.log("PART A — Total and Grand total");
  const t = r("total");
  bar("A1 Total = the six cohorts (1+2+3+4+5+0) on sends",
    t.sends === 1000 * sumOf([1, 2, 3, 4, 5]), `${t.sends}`);
  bar("A2 ⭐ Total EXCLUDES Unclassified", t.sends === 15000, `${t.sends}`);
  const g = r("grand_total");
  const d = r("drip");
  bar("A3 ⭐ Grand total = Total + Unclassified + Drip on sends",
    g.sends === t.sends + r("unclassified").sends + d.sends && g.sends === 39000,
    `${g.sends} = ${t.sends} + ${r("unclassified").sends} + ${d.sends}`);
  bar("A4 Grand total sums every counted column, not just sends (k = 1..9 minus 6)",
    g.clickers === 3900 && g.sales === 390 && g.purchases === 429 &&
      g.opt_outs === 39 && near(Number(g.revenue), 195) && near(Number(g.cost), 78),
    `clk ${g.clickers} sales ${g.sales} purch ${g.purchases} opt ${g.opt_outs} rev ${g.revenue} cost ${g.cost}`);
  bar("A5 Grand total ratios are re-derived from the summed parts, not averaged",
    near(g.ctr ?? -1, 3900 / 39000) && near(g.cr ?? -1, 390 / 3900),
    `ctr ${g.ctr} cr ${g.cr}`);
  bar("A6 a missing cohort cell is a zero row, present",
    r("suppressed").sends === 0 && r("suppressed").ctr === null);
  bar("A7 row order: … Total, Unclassified, Drip, Grand total last",
    rep.rows.slice(-4).map((x) => x.row).join(",") === "total,unclassified,drip,grand_total",
    rep.rows.map((x) => x.row).join(","));

  console.log("\nPART C — Drip is its own row");
  bar("C1 ⭐ Drip = every drip cell, stamped or not (8 + 9)",
    d.sends === 17000 && near(Number(d.revenue), 85), `${d.sends}, rev ${d.revenue}`);
  bar("C2 ⭐ a drip send stamped cold is NOT in the Cold row",
    r("cold").sends === 2000, `cold ${r("cold").sends}`);
  bar("C3 …nor in Unclassified, which is regular sends without a stamp",
    r("unclassified").sends === 7000, `${r("unclassified").sends}`);
  bar("C4 …nor in Total", t.sends === 15000, `${t.sends}`);

  console.log("\nPART B — Purchases and ROI");
  bar("B1 Purchases is summed independently of Sales",
    r("cold").purchases === 22 && r("cold").sales === 20);
  const roiRows = foldLifecycleRows(
    [
      cell("hot", 1, { cost: 10, revenue: 25 }),   // +150%
      cell("cold", 1, { cost: 10, revenue: 0 }),   // −100%
      cell("warm", 1, { cost: 0, revenue: 5 }),    // nothing spent ⇒ null
      cell("new", 1, { cost: 10, revenue: 10 }),   // break-even ⇒ 0
    ],
    "2026-09-23",
    "2026-10-22",
  ).rows;
  const roi = (k: string) => roiRows.find((x) => x.row === k)!.roi;
  bar("B2 ROI = (revenue − cost) ÷ cost", near(roi("hot") ?? NaN, 1.5), `${roi("hot")}`);
  bar("B3 ROI is −100% when nothing was earned", near(roi("cold") ?? NaN, -1), `${roi("cold")}`);
  bar("B4 ⭐ ROI is null, not ∞ or 0, when nothing was spent", roi("warm") === null, `${roi("warm")}`);
  bar("B5 ROI is exactly 0 at break-even", roi("new") === 0, `${roi("new")}`);
  const tr = roiRows.find((x) => x.row === "total")!;
  bar("B6 Total ROI is from summed revenue and cost, not an average of ROIs",
    near(tr.roi ?? NaN, (40 - 30) / 30), `${tr.roi}`);

  console.log("\nPART D — Warm split rows and Cost / new clicker");
  const w = foldLifecycleRows(
    [
      cell("hot", 1),
      cell("warm_31_60", 2),
      cell("warm_61_120", 4),
      cell("warm", 8), // stamp with no click time
      cell("cold", 16),
    ],
    "2026-09-23",
    "2026-10-22",
  ).rows;
  const wr = (k: string) => w.find((x) => x.row === k)!;
  bar("D1 both Warm rows are rows of their own",
    wr("warm_31_60").sends === 2000 && wr("warm_61_120").sends === 4000);
  bar("D2 ⭐ Clickers = Hot + Warm 31–60 + Warm 61–120 + Warm (no click time)",
    wr("clickers").sends === 15000, `${wr("clickers").sends}`);
  bar("D3 Total includes every Warm row", wr("total").sends === 31000, `${wr("total").sends}`);
  bar("D4 New clickers is summed like any count",
    wr("total").new_clickers === 93 && wr("clickers").new_clickers === 45,
    `total ${wr("total").new_clickers}, clickers ${wr("clickers").new_clickers}`);

  const c = foldLifecycleRows(
    [
      cell("hot", 1, { cost: 10, revenue: 4, newClickers: 3 }),   // (10−4)/3 = 2
      cell("cold", 1, { cost: 10, revenue: 25, newClickers: 5 }), // pays for itself
      cell("warm_31_60", 1, { cost: 10, revenue: 0, newClickers: 0 }), // blank
      cell("new", 1, { cost: 10, revenue: 10, newClickers: 4 }),  // break-even ⇒ 0
    ],
    "2026-09-23",
    "2026-10-22",
  ).rows;
  const cr = (k: string) => c.find((x) => x.row === k)!;
  bar("D5 Cost / new clicker = (cost − revenue) ÷ new clickers",
    near(cr("hot").cost_per_new_clicker ?? NaN, 2) && !cr("hot").pays_for_itself,
    `${cr("hot").cost_per_new_clicker}`);
  bar("D6 ⭐ revenue > cost ⇒ null and pays_for_itself, never a negative cost",
    cr("cold").cost_per_new_clicker === null && cr("cold").pays_for_itself,
    `${cr("cold").cost_per_new_clicker} / ${cr("cold").pays_for_itself}`);
  bar("D7 ⭐ zero new clickers ⇒ null (blank), not ∞",
    cr("warm_31_60").cost_per_new_clicker === null, `${cr("warm_31_60").cost_per_new_clicker}`);
  bar("D8 break-even ⇒ exactly 0, and does not 'pay for itself'",
    cr("new").cost_per_new_clicker === 0 && !cr("new").pays_for_itself,
    `${cr("new").cost_per_new_clicker}`);

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
