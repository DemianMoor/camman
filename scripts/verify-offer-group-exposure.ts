import "./_env-preload";

// VERIFY offer_group_exposure_mv (migration 0227) after the first fill —
// READ-ONLY (one BEGIN READ ONLY transaction on its own connection,
// scripts/_readonly-db.ts).
//
// Bars E1–E4 and the reported 0x gap are defined in
// lib/reporting/offer-group-exposure-checks.ts (pinned by
// scripts/test-offer-group-exposure-checks.ts):
//   E1  same (org, offer, group) keys as offer_group_lifecycle_v2_mv
//   E2  zero NULL and zero negative cells
//   E3  eligible <= 0x + 1x on every cell
//   E4  0x + 1x + 2x+ identical across every offer of a group, per cohort
//   gap 0x vs v2's fresh pool per cohort — reported, not a bar (different
//       sources by design: contact_offer_campaigns vs offer_exposures)
// Exit 1 on any failed bar.
//
// Run: npx tsx --conditions=react-server scripts/verify-offer-group-exposure.ts

async function main() {
  const { withReadOnlyDb } = await import("./_readonly-db");
  const { checkExposureView, exposureGap, EXPOSURE_COHORTS, EXPOSURE_VIEW_COLUMNS } = await import(
    "@/lib/reporting/offer-group-exposure-checks"
  );
  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x").hostname;
  console.log(`read-only verify against ${host} at ${new Date().toISOString()}`);

  const { exposure, v2, meta } = await withReadOnlyDb(async (tx) => {
    const meta = await tx<{ view_name: string; refreshed_at: string | null }[]>`
      SELECT view_name, refreshed_at::text FROM report_refresh_log
      WHERE view_name IN ('offer_group_exposure_mv', 'offer_group_lifecycle_v2_mv') ORDER BY 1`;
    const exposure = await tx`SELECT * FROM offer_group_exposure_mv`;
    const v2 = await tx`SELECT * FROM offer_group_lifecycle_v2_mv`;
    return { exposure: [...exposure], v2: [...v2], meta };
  });
  console.log("refresh stamps:", JSON.stringify(meta));

  const r = checkExposureView(exposure, v2);
  let fail = 0;
  const bar = (name: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) fail++;
  };
  bar("E1 same keys as offer_group_lifecycle_v2_mv (0 lost, 0 added)",
    r.lost.length === 0 && r.added.length === 0,
    `exposure ${r.rows}, v2 ${v2.length}, lost ${r.lost.length}, added ${r.added.length}` +
      (r.lost.length + r.added.length ? ` e.g. ${[...r.lost, ...r.added].slice(0, 3).join(", ")}` : ""));
  bar("E2 zero NULL and zero negative cells", r.nullCells === 0 && r.negativeCells === 0,
    `${r.nullCells} NULL, ${r.negativeCells} negative over ${r.rows} rows × ${EXPOSURE_VIEW_COLUMNS.length} columns`);
  bar("E3 eligible <= 0x + 1x on every cell", r.eligibleOver.length === 0,
    `${r.eligibleOver.length} cell(s)${r.eligibleOver.length ? `: ${r.eligibleOver.slice(0, 5).join("; ")}` : ""}`);
  bar("E4 0x + 1x + 2x+ identical across the offers of each group, per cohort", r.partitionMismatches.length === 0,
    `${r.partitionMismatches.length} (group, cohort)${r.partitionMismatches.length ? `: ${r.partitionMismatches.slice(0, 5).join("; ")}` : ""}`);

  console.log("\ncolumn totals:");
  for (const c of EXPOSURE_COHORTS)
    console.log(
      `  ${c.padEnd(7)} 0x ${r.totals[`${c}_x0`].toLocaleString()} · 1x ${r.totals[`${c}_x1`].toLocaleString()} · ` +
        `2x+ ${r.totals[`${c}_x2plus`].toLocaleString()} · eligible ${r.totals[`${c}_eligible`].toLocaleString()}`,
    );

  console.log("\n0x gap vs the old fresh pool (reported, not a bar):");
  for (const g of exposureGap(exposure, v2))
    console.log(
      `  ${g.cohort.padEnd(7)} old fresh ${g.oldFresh.toLocaleString()} → 0x ${g.newX0.toLocaleString()} ` +
        `(${g.newX0 - g.oldFresh >= 0 ? "+" : ""}${(g.newX0 - g.oldFresh).toLocaleString()}); ` +
        `${g.cellsDiffering} cell(s) differ; largest ${g.maxCellDiff.toLocaleString()}` +
        (g.maxCellDiffPct == null ? "" : ` = ${g.maxCellDiffPct.toFixed(2)}% of its cell`) +
        (g.maxCellKey ? ` (${g.maxCellKey})` : ""),
    );

  console.log(fail ? `\n${fail} bar(s) FAILED` : "\nAll bars passed.");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
