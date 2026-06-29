// Unit test for the Keitaro aggregate poll's per-row folds (lib/keitaro/poll.ts).
//
// Pins the 2026-06-29 attribution fix: CLICKS come from report/build rows
// (applyRowToAggregate, split into visits vs offer redirects, dated by click day),
// while CONVERSIONS come from conversions/log rows (applyConversionRowToAggregate,
// dated by the conversion's own day). report/build rows NO LONGER credit
// sales/checkouts/revenue — that would date a sale on the click day, not the day
// it happened. Pure logic, no DB / no network.
//
// Run: npx tsx scripts/test-keitaro-visit-conversions.ts
import {
  applyRowToAggregate,
  applyConversionRowToAggregate,
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

// 1. A VISIT-campaign report row: clicks count as visits; conversions/revenue are
//    NOT credited from report/build (they ride conversions/log now).
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
  check("report row does NOT credit sales", agg.sales === 0, `got ${agg.sales}`);
  check("report row does NOT credit checkouts", agg.checkouts === 0, `got ${agg.checkouts}`);
  check("report row does NOT credit revenue", agg.revenue === 0, `got ${agg.revenue}`);
  check("visit row adds no cost", agg.cost === 0, `got ${agg.cost}`);
}

// 2. An OFFER-campaign report row: clicks are redirects, cost rides the offer side,
//    still no conversion crediting from report/build.
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
  check("report row does NOT credit sales", agg.sales === 0, `got ${agg.sales}`);
  check("offer row credits cost", agg.cost === 4, `got ${agg.cost}`);
}

// 3. conversions/log fold: each row is one sale; a lead-status row is also a
//    checkout; revenue sums. (Dating by the conversion's own day is the caller's
//    job — it picks the (stage, date) aggregate before calling this.)
{
  const agg = freshAgg();
  applyConversionRowToAggregate(agg, { status: "lead", revenue: 75 });
  applyConversionRowToAggregate(agg, { status: "lead", revenue: 75 });
  applyConversionRowToAggregate(agg, { status: "sale", revenue: 100 });
  check("3 conversion rows → 3 sales", agg.sales === 3, `got ${agg.sales}`);
  check("2 lead-status rows → 2 checkouts", agg.checkouts === 2, `got ${agg.checkouts}`);
  check("revenue sums to 250", agg.revenue === 250, `got ${agg.revenue}`);
}

// 4. A rejected conversion still counts as a sale (matches Keitaro's `conversions`
//    metric, which the fetch filters to lead/sale/rejected) but not a checkout.
{
  const agg = freshAgg();
  applyConversionRowToAggregate(agg, { status: "rejected", revenue: 0 });
  check("rejected → 1 sale", agg.sales === 1, `got ${agg.sales}`);
  check("rejected → 0 checkouts", agg.checkouts === 0, `got ${agg.checkouts}`);
}

// 5. Combined: clicks from a report row + conversions from the log, on the SAME
//    aggregate — both sides accumulate independently.
{
  const agg = freshAgg();
  applyRowToAggregate(agg, { clicks: 46, campaign_unique_clicks: 39 }, true);
  applyRowToAggregate(agg, { clicks: 11, campaign_unique_clicks: 9, cost: 4 }, false);
  applyConversionRowToAggregate(agg, { status: "lead", revenue: 75 });
  check("combined visitClean = 39", agg.visitClean === 39, `got ${agg.visitClean}`);
  check("combined redirectClean = 9", agg.redirectClean === 9, `got ${agg.redirectClean}`);
  check("combined cost = 4", agg.cost === 4, `got ${agg.cost}`);
  check("combined sales = 1", agg.sales === 1, `got ${agg.sales}`);
  check("combined revenue = 75", agg.revenue === 75, `got ${agg.revenue}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
