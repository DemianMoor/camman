// Unit test for lib/reporting/offer-group-exposure-checks.ts (migration 0227's
// verify bar). Pure — no database.
//
// Run: npx tsx scripts/test-offer-group-exposure-checks.ts
import {
  checkExposureView,
  EXPOSURE_VIEW_COLUMNS,
  exposureGap,
} from "../lib/reporting/offer-group-exposure-checks";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`✓ ${name}`); }
  else { failed++; console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ORG = "o1";
// Group 7 is targeted by offers 1 and 2: per cohort, x0+x1+x2plus must agree.
function row(offer: number, group: number, over: Record<string, number | null> = {}) {
  const r: Record<string, unknown> = { org_id: ORG, offer_id: offer, group_id: group };
  for (const c of EXPOSURE_VIEW_COLUMNS) r[c] = 0;
  // hot: 10 sendable = 6 + 3 + 1, 7 eligible
  Object.assign(r, { hot_x0: 6, hot_x1: 3, hot_x2plus: 1, hot_eligible: 7 });
  return Object.assign(r, over);
}
const v2 = (offer: number, group: number, fresh: Record<string, number> = {}) => ({
  org_id: ORG, offer_id: offer, group_id: group,
  hot_fresh_pool: 6, warm_fresh_pool: 0, cold_fresh_pool: 0, freeze_fresh_pool: 0, ...fresh,
});

{
  const exp = [row(1, 7), row(2, 7, { hot_x0: 5, hot_x1: 4 }), row(1, 8)];
  const r = checkExposureView(exp, [v2(1, 7), v2(2, 7), v2(1, 8)]);
  check("clean: same keys", r.lost.length === 0 && r.added.length === 0);
  check("clean: no NULL / negative cells", r.nullCells === 0 && r.negativeCells === 0);
  check("clean: eligible within 0x+1x", r.eligibleOver.length === 0);
  check("clean: a different split with the SAME sendable total is consistent", r.partitionMismatches.length === 0);
  check("totals add per column", r.totals.hot_x0 === 6 + 5 + 6 && r.totals.hot_x2plus === 3);
}
{
  const r = checkExposureView([row(1, 7)], [v2(1, 7), v2(2, 7)]);
  check("a v2 key missing from the exposure view is lost", r.lost.length === 1 && r.lost[0] === "o1|2|7");
  const r2 = checkExposureView([row(1, 7), row(3, 9)], [v2(1, 7)]);
  check("an exposure key absent from v2 is added", r2.added.length === 1 && r2.added[0] === "o1|3|9");
}
{
  const r = checkExposureView([row(1, 7, { warm_x1: null, cold_x0: -1 })], [v2(1, 7)]);
  check("NULL and negative cells are counted separately", r.nullCells === 1 && r.negativeCells === 1);
}
{
  const r = checkExposureView([row(1, 7, { hot_eligible: 10 })], [v2(1, 7)]);
  check("eligible > 0x+1x is flagged (2x+ must never be eligible)", r.eligibleOver.length === 1 && r.eligibleOver[0] === "o1|1|7 hot");
  const r2 = checkExposureView([row(1, 7, { hot_eligible: 9 })], [v2(1, 7)]);
  check("eligible = 0x+1x is allowed (boundary)", r2.eligibleOver.length === 0);
}
{
  const r = checkExposureView([row(1, 7), row(2, 7, { hot_x2plus: 2 })], [v2(1, 7), v2(2, 7)]);
  check("a group whose sendable total differs between offers is a partition mismatch",
    r.partitionMismatches.length === 1 && r.partitionMismatches[0].startsWith("o1|7|hot"), r.partitionMismatches.join("; "));
}
{
  const g = exposureGap([row(1, 7), row(2, 7, { hot_x0: 5, hot_x1: 4 })], [v2(1, 7), v2(2, 7, { hot_fresh_pool: 4 })]);
  const hot = g.find((x) => x.cohort === "hot")!;
  check("gap: sums old fresh pool and new 0x", hot.oldFresh === 10 && hot.newX0 === 11);
  check("gap: counts differing cells and the largest one as % of the old cell",
    hot.cellsDiffering === 1 && hot.maxCellDiff === 1 && hot.maxCellDiffPct === 25 && hot.maxCellKey === "o1|2|7",
    JSON.stringify(hot));
  const cold = g.find((x) => x.cohort === "cold")!;
  check("gap: an identical cohort reports zero", cold.cellsDiffering === 0 && cold.maxCellDiffPct === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
