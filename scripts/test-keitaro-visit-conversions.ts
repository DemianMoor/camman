// Unit test for the Keitaro aggregate poll's per-row folds (lib/keitaro/poll.ts).
//
// Pins the 2026-06-29 attribution fix: CLICKS come from report/build rows
// (applyRowToAggregate, split into visits vs offer redirects, dated by click day),
// while CONVERSIONS are no longer folded here at all: keitaro_stage_results'
// conversion columns are re-derived from the conversion_events ledger by
// lib/keitaro/stage-day-conversions.ts (covered by
// scripts/test-stage-day-conversions.ts on camman-v2). This script is the
// CLICK-side classifier only.
//
// Run: npx tsx scripts/test-keitaro-visit-conversions.ts
import { applyRowToAggregate, type StageDayAgg } from "@/lib/keitaro/poll";
import type { KeitaroReportRow } from "@/lib/keitaro/client";

function freshAgg(): StageDayAgg {
  return {
    orgId: "org",
    campaignId: 1,
    stageId: 1,
    tid: "t",
    statDate: "2026-06-24",
    visitRaw: 0,
    visitClean: 0,
    redirectRaw: 0,
    redirectClean: 0,
    cost: 0,
  };
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// 1. A VISIT-campaign report row: clicks count as visits.
{
  const agg = freshAgg();
  const visitRow: KeitaroReportRow = {
    clicks: 46,
    campaign_unique_clicks: 39,
    leads: 2,
    conversions: 2,
    sales: 0,
    revenue: 150,
    cost: 0,
  };
  applyRowToAggregate(agg, visitRow, true);
  check("visit clicks → visitClean", agg.visitClean === 39, `got ${agg.visitClean}`);
  check("visit row adds 0 redirect clicks", agg.redirectRaw === 0, `got ${agg.redirectRaw}`);
  check("visit row adds no cost", agg.cost === 0, `got ${agg.cost}`);
}

// 2. An OFFER-campaign report row: clicks are redirects, cost rides the offer side.
{
  const agg = freshAgg();
  const offerRow: KeitaroReportRow = {
    clicks: 11,
    campaign_unique_clicks: 9,
    leads: 1,
    conversions: 1,
    sales: 0,
    revenue: 75,
    cost: 4,
  };
  applyRowToAggregate(agg, offerRow, false);
  check("offer clicks → redirectClean", agg.redirectClean === 9, `got ${agg.redirectClean}`);
  check("offer row adds 0 visit clicks", agg.visitClean === 0, `got ${agg.visitClean}`);
  check("offer row credits cost", agg.cost === 4, `got ${agg.cost}`);
}

// 3. Combined: a visit row + an offer row fold into the SAME aggregate — both
//    sides accumulate independently.
{
  const agg = freshAgg();
  applyRowToAggregate(agg, { clicks: 46, campaign_unique_clicks: 39 }, true);
  applyRowToAggregate(agg, { clicks: 11, campaign_unique_clicks: 9, cost: 4 }, false);
  check("combined visitClean = 39", agg.visitClean === 39, `got ${agg.visitClean}`);
  check("combined redirectClean = 9", agg.redirectClean === 9, `got ${agg.redirectClean}`);
  check("combined cost = 4", agg.cost === 4, `got ${agg.cost}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
