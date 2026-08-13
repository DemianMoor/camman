// Unit tests for the delivery report's PURE aggregators and the undelivered
// tripwire's breach predicate. No database — these are the rules that decide
// what a number means and whether an alert fires, so they are testable in
// isolation (same pattern as dlrCoverageBreached / inboundSilenceBreached).
//
// Run: npx tsx scripts/test-delivery-rollups.ts

import {
  DLR_SOURCES,
  deliveredPct,
  isDlrCapable,
  rollupByCampaign,
  rollupByProvider,
  rollupByStage,
  undeliveredPct,
  type DeliveryStageRow,
  type ProviderInfo,
  type StageMeta,
} from "@/lib/reporting/delivery";
import { undeliveredTripwireBreached } from "@/lib/sends/tells-monitors";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

// --- fixtures ---------------------------------------------------------------
// Two providers: tls (DLR-capable) and txh (not). Campaign 1 is single-provider
// tls; campaign 2 is MIXED (a tls stage and a txh stage) — the 4-of-212 case.
const stages = new Map<number, StageMeta>([
  [10, { campaign_id: 1, provider_key: "tls" }],
  [11, { campaign_id: 1, provider_key: "tls" }],
  [20, { campaign_id: 2, provider_key: "tls" }],
  [21, { campaign_id: 2, provider_key: "txh" }],
]);
const registry: ProviderInfo[] = [
  { provider_key: "tls", name: "Tells", color: null, archived: false },
  { provider_key: "txh", name: "TextHub", color: null, archived: false },
  { provider_key: "smpl", name: "SimpleTexting", color: null, archived: false },
];
const rows: DeliveryStageRow[] = [
  { stage_id: 10, sent: 500, delivered: 457, undelivered: 29, no_receipt: 14 },
  { stage_id: 11, sent: 100, delivered: 90, undelivered: 10, no_receipt: 0 },
  { stage_id: 20, sent: 400, delivered: 380, undelivered: 12, no_receipt: 8 },
  { stage_id: 21, sent: 9600, delivered: 0, undelivered: 0, no_receipt: 9600 },
];

// --- capability declaration -------------------------------------------------
console.log("\ncapability declaration:");
check("tls / txr / ahi are declared capable", ["tls", "txr", "ahi"].every(isDlrCapable));
check(
  "txh / txh2 / snx / smpl are NOT capable",
  ["txh", "txh2", "snx", "smpl"].every((k) => !isDlrCapable(k)),
);
check("an unknown/future provider defaults to NOT capable", !isDlrCapable("brandnew"));
check("null provider key is not capable", !isDlrCapable(null));
// The txr source must key off BOTH id columns: the poll path populates
// matched_stage_send_id while the callback path carries stage_send_id from ?ss=.
check(
  "txr source coalesces both stage-send id columns",
  DLR_SOURCES.txr.key.includes("matched_stage_send_id") &&
    DLR_SOURCES.txr.key.includes("stage_send_id"),
  DLR_SOURCES.txr.key,
);
// tls shares its table with inbound replies; without the filter, STOP replies
// would be counted as delivery receipts.
check("tls source filters to kind='dlr'", DLR_SOURCES.tls.filter === "kind = 'dlr'");

// --- percentages ------------------------------------------------------------
console.log("\npercentages:");
eq("deliveredPct on the verified tls batch", deliveredPct(rows[0]), (457 / 500) * 100);
eq(
  "undeliveredPct reproduces the runbook's 5.8% baseline",
  Number(undeliveredPct(rows[0])!.toFixed(1)),
  5.8,
);
eq("deliveredPct is null on a zero denominator, not 0", deliveredPct({ sent: 0, delivered: 0, undelivered: 0, no_receipt: 0 }), null);

// --- provider rollup --------------------------------------------------------
console.log("\nrollupByProvider:");
const byProvider = rollupByProvider(rows, stages, registry);
const tls = byProvider.find((p) => p.provider_key === "tls")!;
const txh = byProvider.find((p) => p.provider_key === "txh")!;
const smpl = byProvider.find((p) => p.provider_key === "smpl")!;

eq("tls sent sums its three stages", tls.sent, 1000);
eq("tls delivered sums its three stages", tls.delivered, 927);
eq("tls columns foot: delivered+undelivered+no_receipt == sent", (tls.delivered ?? 0) + (tls.undelivered ?? 0) + (tls.no_receipt ?? 0), tls.sent);

// THE ONE THAT MATTERS. An ungated computation renders 99.9% of platform volume
// as "0.0% delivered", which reads as a total outage.
eq("non-capable provider still reports Sent", txh.sent, 9600);
eq("non-capable delivered is NULL, not 0", txh.delivered, null);
eq("non-capable undelivered is NULL, not 0", txh.undelivered, null);
eq("non-capable no_receipt is NULL, not 0", txh.no_receipt, null);
eq("non-capable Delivered % is NULL, not 0", txh.delivered_pct, null);
check("non-capable provider is flagged", !txh.dlr_capable);

eq("a provider with no sends in the window shows a zero row", smpl.sent, 0);
eq("...and still reports NULL, not 0%, when non-capable", smpl.delivered_pct, null);
check("registry drives the rows — all 3 providers present", byProvider.length === 3);
check("rows sort by sent desc", byProvider[0].provider_key === "txh");

// --- campaign rollup (mixed-provider) --------------------------------------
console.log("\nrollupByCampaign:");
const byCampaign = rollupByCampaign(rows, stages);
const c1 = byCampaign.get(1)!;
const c2 = byCampaign.get(2)!;

eq("single-provider campaign: coverage is 100%", c1.coverage_pct, 100);
eq("single-provider campaign: pct over all its sends", c1.delivered_pct, (547 / 600) * 100);

// The mixed case: 400 of 10,000 sends are DLR-capable.
eq("mixed campaign: total_sent counts ALL sends", c2.total_sent, 10000);
eq("mixed campaign: capable_sent counts only DLR-capable sends", c2.capable_sent, 400);
eq("mixed campaign: pct is over the CAPABLE subset", c2.delivered_pct, (380 / 400) * 100);
eq("mixed campaign: coverage is labelled at 4%", c2.coverage_pct, 4);
check(
  "mixed campaign pct is NOT diluted by non-capable sends",
  c2.delivered_pct !== null && c2.delivered_pct > 90,
  `got ${c2.delivered_pct}`,
);

// A campaign with no capable sends at all must dash, not read 0%.
const soloTxh = rollupByCampaign([rows[3]], stages).get(2)!;
eq("campaign with zero capable sends: pct is NULL", soloTxh.delivered_pct, null);
eq("...and coverage is 0", soloTxh.coverage_pct, 0);

// --- stage rollup -----------------------------------------------------------
console.log("\nrollupByStage:");
const byStage = rollupByStage(rows, stages);
eq("capable stage: coverage is always 100% (stages are single-provider)", byStage.get(10)!.coverage_pct, 100);
eq("capable stage: pct", byStage.get(10)!.delivered_pct, (457 / 500) * 100);
eq("non-capable stage: pct is NULL", byStage.get(21)!.delivered_pct, null);
eq("non-capable stage: coverage is 0", byStage.get(21)!.coverage_pct, 0);

// --- rollups reconcile ------------------------------------------------------
console.log("\nrollups reconcile from the same stage rows:");
const provSent = byProvider.reduce((n, p) => n + p.sent, 0);
const campSent = [...byCampaign.values()].reduce((n, c) => n + c.total_sent, 0);
const stageSent = rows.reduce((n, r) => n + r.sent, 0);
eq("provider totals == stage totals", provSent, stageSent);
eq("campaign totals == stage totals", campSent, stageSent);

// --- tripwire breach predicate ---------------------------------------------
console.log("\nundelivered tripwire (>8% on a matured batch):");
eq("5.8% baseline does NOT breach", undeliveredTripwireBreached(500, 29), false);
eq("exactly 8.0% does NOT breach (strictly greater)", undeliveredTripwireBreached(1000, 80), false);
eq("8.1% breaches", undeliveredTripwireBreached(1000, 81), true);
// Below the volume floor a rate is noise, and alerting on noise is how a
// monitor gets muted — the failure mode the Tells monitors were built around.
eq("49 sends is below the floor — no breach even at 100%", undeliveredTripwireBreached(49, 49), false);
eq("50 sends is at the floor — breaches at 100%", undeliveredTripwireBreached(50, 50), true);
eq("zero sends never breaches", undeliveredTripwireBreached(0, 0), false);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
