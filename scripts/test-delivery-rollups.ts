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
  type PhoneMeta,
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
// Providers: tls (DLR-capable) and txh2 (not). Campaign 1 is single-provider
// tls; campaign 2 is MIXED-capability (a tls stage and a txh2 stage).
//
// txh2 runs TWO numbers — a short code and a toll-free — which is the real prod
// shape and the reason this breakdown exists: one provider, two very different
// deliverability profiles.
//
// Stage 11 is SPLIT ACROSS TWO NUMBERS: the resumable-materialization case
// (phone edited between committed windows). It is 0-of-882 in prod today but is
// not structurally prevented, and it is exactly what deriving the phone from the
// stage would misattribute.
const PH = { tlsTfn: 1, txh2Short: 2, txh2Tfn: 3, tlsTfn2: 4 };
const phones = new Map<number, PhoneMeta>([
  [PH.tlsTfn, { provider_phone_id: PH.tlsTfn, phone_number: "+18445694179", number_type: "toll_free", provider_key: "tls" }],
  [PH.txh2Short, { provider_phone_id: PH.txh2Short, phone_number: "621637", number_type: "short_code", provider_key: "txh2" }],
  [PH.txh2Tfn, { provider_phone_id: PH.txh2Tfn, phone_number: "+18446210404", number_type: "toll_free", provider_key: "txh2" }],
  [PH.tlsTfn2, { provider_phone_id: PH.tlsTfn2, phone_number: "+18445690000", number_type: "toll_free", provider_key: "tls" }],
]);
const stages = new Map<number, StageMeta>([
  [10, { campaign_id: 1 }],
  [11, { campaign_id: 1 }],
  [20, { campaign_id: 2 }],
  [21, { campaign_id: 2 }],
]);
const registry: ProviderInfo[] = [
  { provider_key: "tls", name: "Tells", color: null, archived: false },
  { provider_key: "txh2", name: "TextHub 2", color: null, archived: false },
  { provider_key: "smpl", name: "SimpleTexting", color: null, archived: false },
];
const rows: DeliveryStageRow[] = [
  { stage_id: 10, provider_phone_id: PH.tlsTfn, sent: 500, delivered: 457, undelivered: 29, no_receipt: 14 },
  // stage 11 split across two tls numbers — one stage, two rows.
  { stage_id: 11, provider_phone_id: PH.tlsTfn, sent: 60, delivered: 55, undelivered: 5, no_receipt: 0 },
  { stage_id: 11, provider_phone_id: PH.tlsTfn2, sent: 40, delivered: 35, undelivered: 5, no_receipt: 0 },
  { stage_id: 20, provider_phone_id: PH.tlsTfn, sent: 400, delivered: 380, undelivered: 12, no_receipt: 8 },
  // txh2's two numbers, both non-capable.
  { stage_id: 21, provider_phone_id: PH.txh2Short, sent: 8600, delivered: 0, undelivered: 0, no_receipt: 8600 },
  { stage_id: 21, provider_phone_id: PH.txh2Tfn, sent: 1000, delivered: 0, undelivered: 0, no_receipt: 1000 },
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
const byProvider = rollupByProvider(rows, phones, registry);
const tls = byProvider.find((p) => p.provider_key === "tls")!;
const txh = byProvider.find((p) => p.provider_key === "txh2")!;
const smpl = byProvider.find((p) => p.provider_key === "smpl")!;

eq("tls sent sums all its rows", tls.sent, 1000);
eq("tls delivered sums all its rows", tls.delivered, 927);
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
check("rows sort by sent desc", byProvider[0].provider_key === "txh2");

// --- per-number breakdown ---------------------------------------------------
// The motivating case: ONE provider running numbers with different profiles.
// In prod today txh2 = short code 621637 (308,828 sends) + TFN +1844…0404
// (36,802) — collapsed into a single row before this change.
console.log("\nper-number breakdown:");
eq("txh2 breaks into its two numbers", txh.numbers.length, 2);
eq("number sub-rows sum to the provider row", txh.numbers.reduce((n, x) => n + x.sent, 0), txh.sent);
eq("sub-rows sort by sent desc", txh.numbers[0].phone_number, "621637");
eq("the short code is labelled", txh.numbers[0].number_type, "short_code");
eq("the toll-free is labelled", txh.numbers[1].number_type, "toll_free");
// Capability is per-PROVIDER, so both numbers inherit it. Deliverability can
// differ per number; MEASURABILITY cannot.
check("both txh2 numbers inherit the provider's non-capability",
  txh.numbers.every((x) => !x.dlr_capable && x.delivered_pct === null));

eq("tls breaks into its two numbers", tls.numbers.length, 2);
eq("tls sub-rows sum to the provider row", tls.numbers.reduce((n, x) => n + x.sent, 0), tls.sent);
check("capable numbers carry real percentages",
  tls.numbers.every((x) => x.dlr_capable && x.delivered_pct !== null));
// Each number's own columns must foot independently, not just the parent's.
check("every number row foots",
  byProvider.every((p) => p.numbers.every((x) =>
    !x.dlr_capable || (x.delivered ?? 0) + (x.undelivered ?? 0) + (x.no_receipt ?? 0) === x.sent)));
eq("a provider with no sends has no number sub-rows", smpl.numbers.length, 0);

// ⭐ THE REGRESSION THIS GRAIN CHANGE EXISTS FOR. Stage 11 sent from two
// different numbers (phone edited between materialization windows). Deriving the
// phone from the stage would attribute all 100 of its sends to whichever number
// the stage row happens to hold NOW — silently, on the very number someone is
// investigating. Keying off the send splits them correctly.
const tls1 = tls.numbers.find((x) => x.phone_number === "+18445694179")!;
const tls2 = tls.numbers.find((x) => x.phone_number === "+18445690000")!;
eq("split stage: first number gets its own sends", tls1.sent, 960);
eq("split stage: second number gets its own sends", tls2.sent, 40);
check("the split stage is NOT collapsed onto one number", tls2.sent !== 0 && tls1.sent !== 1000);

// --- campaign rollup (mixed-provider) --------------------------------------
console.log("\nrollupByCampaign:");
const byCampaign = rollupByCampaign(rows, stages, phones);
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
const soloTxh = rollupByCampaign(rows.filter((r) => r.stage_id === 21), stages, phones).get(2)!;
eq("campaign with zero capable sends: pct is NULL", soloTxh.delivered_pct, null);
eq("...and coverage is 0", soloTxh.coverage_pct, 0);

// --- stage rollup -----------------------------------------------------------
console.log("\nrollupByStage:");
const byStage = rollupByStage(rows, phones);
eq("capable stage: coverage 100%", byStage.get(10)!.coverage_pct, 100);
eq("capable stage: pct", byStage.get(10)!.delivered_pct, (457 / 500) * 100);
eq("non-capable stage: pct is NULL", byStage.get(21)!.delivered_pct, null);
eq("non-capable stage: coverage is 0", byStage.get(21)!.coverage_pct, 0);
// The split stage: two rows, one stage. Must SUM, not overwrite.
eq("split stage sums both of its numbers", byStage.get(11)!.total_sent, 100);
eq("split stage delivered sums both numbers", byStage.get(11)!.delivered, 90);
eq("split stage pct is over the whole stage", byStage.get(11)!.delivered_pct, 90);

// --- rollups reconcile ------------------------------------------------------
console.log("\nrollups reconcile from the same stage rows:");
const provSent = byProvider.reduce((n, p) => n + p.sent, 0);
const campSent = [...byCampaign.values()].reduce((n, c) => n + c.total_sent, 0);
const stageSent = rows.reduce((n, r) => n + r.sent, 0);
const phoneSent = byProvider.reduce((n, p) => n + p.numbers.reduce((m, x) => m + x.sent, 0), 0);
eq("provider totals == stage totals", provSent, stageSent);
eq("campaign totals == stage totals", campSent, stageSent);
eq("per-number totals == stage totals", phoneSent, stageSent);

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
