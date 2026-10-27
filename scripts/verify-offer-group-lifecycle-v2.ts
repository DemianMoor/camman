import "./_env-preload";

// VERIFY offer_group_lifecycle_v2_mv (migration 0226) against the old
// offer_group_lifecycle_mv after the first fill — READ-ONLY (one BEGIN READ
// ONLY transaction on its own connection, scripts/_readonly-db.ts).
//
// The owner's bar (2026-10-26), over every (org, offer, group) row:
//   V1  row count equal to the old view, the same keys (0 lost, 0 added)
//   V2  zero NULL cells in v2
//   V3  Cold and Freeze identical per cell
//   V4  Hot + Warm = the old Hot/Warm per cell
// The two views are refreshed minutes apart (fill-offer-group-lifecycle-v2.ts),
// so V3/V4 can show DRIFT — sends that landed between the two refreshes. Every
// differing cell is REPORTED (count, net and absolute difference, samples), never
// absorbed into a tolerance. Exit 1 on any failure. The comparison itself is the
// pure compareLifecycleViews (lib/reporting/offer-group-lifecycle-compare.ts),
// pinned by scripts/test-offer-group-lifecycle-compare.ts.
//
// Run: npx tsx --conditions=react-server scripts/verify-offer-group-lifecycle-v2.ts

async function main() {
  const { withReadOnlyDb } = await import("./_readonly-db");
  const {
    compareLifecycleViews,
    LIFECYCLE_SAME_COLUMNS,
    LIFECYCLE_SPLIT_WINDOWS,
    LIFECYCLE_V2_COLUMNS,
  } = await import("@/lib/reporting/offer-group-lifecycle-compare");
  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x").hostname;
  console.log(`read-only verify against ${host} at ${new Date().toISOString()}`);

  const { oldRows, newRows, meta } = await withReadOnlyDb(async (tx) => {
    const meta = await tx<{ view_name: string; refreshed_at: string | null }[]>`
      SELECT view_name, refreshed_at::text FROM report_refresh_log
      WHERE view_name IN ('offer_group_lifecycle_mv', 'offer_group_lifecycle_v2_mv') ORDER BY 1`;
    const oldRows = await tx`SELECT * FROM offer_group_lifecycle_mv`;
    const newRows = await tx`SELECT * FROM offer_group_lifecycle_v2_mv`;
    return { oldRows: [...oldRows], newRows: [...newRows], meta };
  });
  console.log("refresh stamps:", JSON.stringify(meta));

  const r = compareLifecycleViews(oldRows, newRows);
  let fail = 0;
  const bar = (name: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) fail++;
  };
  const report = (d: { cells: number; net: number; abs: number; samples: string[] }) =>
    d.cells === 0
      ? "identical"
      : `${d.cells} cell(s) differ, net ${d.net > 0 ? "+" : ""}${d.net}, |Δ| ${d.abs}; ${d.samples.join("; ")}`;

  bar("V1 row count equal, same keys (0 lost, 0 added)",
    r.oldRows === r.newRows && r.lost.length === 0 && r.added.length === 0,
    `old ${r.oldRows}, new ${r.newRows}, lost ${r.lost.length}, added ${r.added.length}` +
      (r.lost.length + r.added.length ? ` e.g. ${[...r.lost, ...r.added].slice(0, 3).join(", ")}` : ""));
  bar("V2 zero NULL cells in v2", r.nullCells === 0,
    `${r.nullCells} NULL cell(s) over ${r.newRows} rows × ${LIFECYCLE_V2_COLUMNS.length} columns`);
  for (const c of LIFECYCLE_SAME_COLUMNS) bar(`V3 ${c} identical per cell`, r.same[c].cells === 0, report(r.same[c]));
  for (const w of LIFECYCLE_SPLIT_WINDOWS)
    bar(`V4 hot_${w} + warm_${w} = hw_${w} per cell`, r.hotWarm[w].cells === 0, report(r.hotWarm[w]));

  console.log("\ncolumn totals (old → new):");
  for (const [c, t] of Object.entries(r.totals))
    console.log(`  ${c.padEnd(40)} ${t.old.toLocaleString()} → ${t.neu.toLocaleString()}`);
  const split = LIFECYCLE_SPLIT_WINDOWS.map((w) => {
    const hot = newRows.reduce((a, x) => a + Number(x[`hot_${w}`]), 0);
    const warm = newRows.reduce((a, x) => a + Number(x[`warm_${w}`]), 0);
    return `${w}: Hot ${hot.toLocaleString()} + Warm ${warm.toLocaleString()}`;
  });
  console.log(`\nthe split: ${split.join(" · ")}`);

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED (drift, if any, is listed above).`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
