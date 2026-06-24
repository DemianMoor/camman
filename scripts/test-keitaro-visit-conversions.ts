// Unit test for applyRowToAggregate (lib/keitaro/poll.ts) — the per-row fold that
// the Keitaro aggregate poll uses. Pure logic, no DB / no network.
//
// Pins the behavior added 2026-06-24: conversions (checkouts/sales/revenue) are
// credited to a stage REGARDLESS of which Keitaro campaign reported them, so a
// conversion stranded on the gk-lp-visits campaign (broken landing→offer redirect)
// is still counted — while CLICKS are still split into visits vs. offer redirects.
//
// Run: npx tsx scripts/test-keitaro-visit-conversions.ts
import {
  applyRowToAggregate,
  type StageDayAgg,
} from "@/lib/keitaro/poll";
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
    checkouts: 0,
    sales: 0,
    revenue: 0,
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

// 1. A VISIT-campaign row carrying conversions (the bug scenario): clicks count as
//    visits, but the conversions/revenue are STILL credited.
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
  check("visit row STILL credits sales (conversions)", agg.sales === 2, `got ${agg.sales}`);
  check("visit row STILL credits checkouts (leads)", agg.checkouts === 2, `got ${agg.checkouts}`);
  check("visit row STILL credits revenue", agg.revenue === 150, `got ${agg.revenue}`);
  check("visit row adds no cost", agg.cost === 0, `got ${agg.cost}`);
}

// 2. An OFFER-campaign row: clicks are redirects, conversions credited, cost rides
//    the offer side.
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
  check("offer row credits sales", agg.sales === 1, `got ${agg.sales}`);
  check("offer row credits revenue", agg.revenue === 75, `got ${agg.revenue}`);
  check("offer row credits cost", agg.cost === 4, `got ${agg.cost}`);
}

// 3. Folding BOTH rows for one stage/day (visit + offer): clicks split by side,
//    conversions/revenue sum across both — no double counting (each conversion is
//    in exactly one row), each side's clicks land in the right bucket.
{
  const agg = freshAgg();
  applyRowToAggregate(agg, { clicks: 46, campaign_unique_clicks: 39, leads: 2, conversions: 2, revenue: 150 }, true);
  applyRowToAggregate(agg, { clicks: 11, campaign_unique_clicks: 9, leads: 1, conversions: 1, revenue: 75, cost: 4 }, false);
  check("combined visitClean = 39", agg.visitClean === 39, `got ${agg.visitClean}`);
  check("combined redirectClean = 9", agg.redirectClean === 9, `got ${agg.redirectClean}`);
  check("combined sales = 2 + 1 = 3", agg.sales === 3, `got ${agg.sales}`);
  check("combined checkouts = 2 + 1 = 3", agg.checkouts === 3, `got ${agg.checkouts}`);
  check("combined revenue = 150 + 75 = 225", agg.revenue === 225, `got ${agg.revenue}`);
  check("combined cost = 4 (offer only)", agg.cost === 4, `got ${agg.cost}`);
}

// 4. A clean visit row with NO conversions (the normal, healthy case): unchanged —
//    only visit clicks, no sales/revenue. Proves the change is a no-op for healthy
//    campaigns.
{
  const agg = freshAgg();
  applyRowToAggregate(agg, { clicks: 100, campaign_unique_clicks: 80, leads: 0, conversions: 0, revenue: 0 }, true);
  check("healthy visit row: clickers only", agg.visitClean === 80 && agg.sales === 0 && agg.revenue === 0,
    `visitClean=${agg.visitClean} sales=${agg.sales} revenue=${agg.revenue}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
