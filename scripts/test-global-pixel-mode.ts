// Pure checks for the per-offer global-pixel setting (migration 0233):
// applyGlobalPixelMode + its wiring in buildConversionEventRows, plus a source
// scan proving no lane / send / audience / segment code reads the setting.
// No DB, no network. Run: npx tsx scripts/test-global-pixel-mode.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  applyGlobalPixelMode,
  buildConversionEventRows,
  hasOurMarker,
  type GlobalPixelMode,
  type Lookups,
  type MappingRule,
} from "../lib/conversions/build-rows";
import type { LedgerSourceRow } from "../lib/conversions/keitaro-row";

let failed = 0;
let passed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (ok) passed++;
  else failed++;
};

const ORG = "00000000-0000-4000-8000-000000000001";
const PURCHASE = 1;
const LEAD = 10;
const NET_AFL = 47; // Affiliati
const NET_OTHER = 5;
const DEBT = 170; // the guarded offer (stored via Keitaro offer 78)
const DEBT_B = 171; // stored via Keitaro offer 79
const OTHER = 62; // an offer on another network, left at default

// Affiliati's network rules as on prod: sale→Purchase, lead→Lead, rejected status-only.
const rules: MappingRule[] = [
  { offerId: null, affiliateNetworkId: NET_AFL, keitaroType: "sale", eventTypeId: PURCHASE, conversionStatus: "approved" },
  { offerId: null, affiliateNetworkId: NET_AFL, keitaroType: "lead", eventTypeId: LEAD, conversionStatus: "approved" },
  { offerId: null, affiliateNetworkId: NET_AFL, keitaroType: "rejected", eventTypeId: null, conversionStatus: "rejected" },
  { offerId: null, affiliateNetworkId: NET_OTHER, keitaroType: "sale", eventTypeId: PURCHASE, conversionStatus: "approved" },
];

const lookupsWith = (mode170: GlobalPixelMode, mode171: GlobalPixelMode = mode170): Lookups => ({
  stageSends: new Map(),
  // Stage 1 is a campaign on offer 170; stage 2 on offer 62.
  stageIdByTrackingId: new Map([
    ["t170", 1],
    ["t62", 2],
  ]),
  stages: new Map([
    [1, { orgId: ORG, campaignId: 11, offerId: DEBT, affiliateNetworkId: NET_AFL }],
    [2, { orgId: ORG, campaignId: 12, offerId: OTHER, affiliateNetworkId: NET_OTHER }],
  ]),
  offersByKeitaroId: new Map([
    [78, { orgId: ORG, offerId: DEBT, affiliateNetworkId: NET_AFL }],
    [79, { orgId: ORG, offerId: DEBT_B, affiliateNetworkId: NET_AFL }],
  ]),
  rulesByOrg: new Map([[ORG, rules]]),
  offerPixelSettings: new Map([
    [DEBT, { mode: mode170, networkCode: "afl" }],
    [DEBT_B, { mode: mode171, networkCode: "afl" }],
    [OTHER, { mode: "default", networkCode: "sweeply" }],
  ]),
  pixelEventTypeIdsByOrg: new Map([[ORG, { lead: LEAD, purchase: PURCHASE }]]),
});

const src = (over: Partial<LedgerSourceRow>): LedgerSourceRow => ({
  eventId: "ev",
  tid: "46518624",
  clickSubid: "u7d3ub.51.9uij",
  subId1: null,
  subId3: "t170",
  keitaroStatus: "sale",
  keitaroType: "sale",
  revenue: "62.0000",
  currency: null,
  occurredAtEt: "2026-11-04 16:45:56",
  lastPostbackAtEt: "2026-11-04 16:45:56",
  keitaroOfferId: 78,
  version: 1,
  statusHistory: null,
  rawParams: { tid: "46518624", status: "sale", payout: "62.0000" }, // global pixel: no `from`
  ...over,
});
const AFL = (p: Record<string, unknown> = {}) => ({ ...p, from: "afl" });

const build = (mode: GlobalPixelMode, s: LedgerSourceRow) => buildConversionEventRows([s], lookupsWith(mode));
const one = (mode: GlobalPixelMode, s: LedgerSourceRow) => {
  const b = build(mode, s);
  return { row: b.rows[0], ignored: b.ignored.length, rows: b.rows.length };
};

console.log("marker");
check("K1 from=afl on an afl offer is our marker", hasOurMarker({ from: "afl" }, "afl"));
check("K2 case and whitespace are ignored", hasOurMarker({ from: " AFL " }, "afl"));
check("K3 no `from` is not our marker", !hasOurMarker({ tid: "1" }, "afl"));
check("K4 another network's code is not our marker", !hasOurMarker({ from: "Sweeply.pro" }, "afl"));
check("K5 null params / null network code are not a marker", !hasOurMarker(null, "afl") && !hasOurMarker({ from: "afl" }, null));
check("K6 a non-string `from` is not a marker", !hasOurMarker({ from: ["afl"] }, "afl"));

console.log("\nunmarked sale on offer 170 (the global pixel), by mode");
const d = one("default", src({}));
check("D1 default: network rules — Purchase/approved (today's behaviour)", d.row?.eventTypeId === PURCHASE && d.row?.status === "approved");
const l = one("lead", src({}));
check("L1 ⭐ lead: event type forced to Lead", l.row?.eventTypeId === LEAD, `got ${l.row?.eventTypeId}`);
check("L2 lead: status stays the rule's (approved)", l.row?.status === "approved");
check("L3 lead: payout, tid and Keitaro type untouched", l.row?.revenue === "62.0000" && l.row?.tid === "46518624" && l.row?.keitaroType === "sale");
check("L4 lead: stored under offer 170", l.row?.offerId === DEBT);
const lp = one("purchase", src({ keitaroType: "lead", keitaroStatus: "lead" }));
check("P1 purchase: an unmarked `lead` is forced to Purchase", lp.row?.eventTypeId === PURCHASE);
const ig = one("ignore", src({}));
check("I1 ⭐ ignore: not written (no row) and reported as ignored", ig.rows === 0 && ig.ignored === 1, JSON.stringify(ig));

console.log("\nmarked conversions always follow the network rules");
for (const mode of ["default", "lead", "purchase", "ignore"] as const) {
  const m = one(mode, src({ rawParams: AFL({ status: "sale" }) }));
  check(`M ${mode}: from=afl sale → Purchase, written`, m.rows === 1 && m.row?.eventTypeId === PURCHASE && m.ignored === 0);
}
const ml = one("purchase", src({ keitaroType: "lead", keitaroStatus: "lead", rawParams: AFL() }));
check("M5 purchase mode: from=afl lead stays Lead", ml.row?.eventTypeId === LEAD);

console.log("\nreversals are never overridden");
for (const mode of ["lead", "purchase", "ignore"] as const) {
  const r = one(mode, src({ keitaroType: "rejected", keitaroStatus: "rejected", revenue: "0.0000" }));
  check(`R ${mode}: unmarked rejected stays status-only (null type, rejected), written`, r.rows === 1 && r.row?.eventTypeId === null && r.row?.status === "rejected");
}

console.log("\nscope: other offers and edge cases");
const o = buildConversionEventRows([src({ subId3: "t62", keitaroOfferId: null })], lookupsWith("ignore"));
check("O1 ⭐ offer 62 (default) is untouched while 170/171 are on ignore", o.rows.length === 1 && o.rows[0].eventTypeId === PURCHASE && o.rows[0].offerId === OTHER);
const stored171 = buildConversionEventRows([src({ keitaroOfferId: 79 })], lookupsWith("default", "lead")).rows[0];
check("O2 ⭐ read from the STORED offer: a campaign on 170 (default) posting to Keitaro offer 79 → 171's `lead` applies", stored171?.offerId === DEBT_B && stored171?.eventTypeId === LEAD, JSON.stringify(stored171));
const stored170 = buildConversionEventRows([src({ keitaroOfferId: 78 })], lookupsWith("default", "lead")).rows[0];
check("O3 …and the same campaign posting to Keitaro offer 78 keeps 170's default", stored170?.offerId === DEBT && stored170?.eventTypeId === PURCHASE);
const unmapped = one("lead", src({ keitaroType: "upsell", keitaroStatus: "upsell" }));
check("O4 an unmarked type no rule maps stays unmapped (not invented into a Lead)", unmapped.row?.eventTypeId === null && unmapped.row?.status === null);
const noType = buildConversionEventRows([src({})], { ...lookupsWith("lead"), pixelEventTypeIdsByOrg: new Map() }).rows[0];
check("O5 an org without a `lead` type keeps the rule result", noType?.eventTypeId === PURCHASE);
check(
  "O6 no setting for the offer ⇒ rule result",
  applyGlobalPixelMode({ setting: undefined, rawParams: null, mapping: { eventTypeId: PURCHASE, status: "approved" }, eventTypeIds: { lead: LEAD, purchase: PURCHASE } }).kind === "rule",
);
const batch = buildConversionEventRows(
  [src({ eventId: "a" }), src({ eventId: "b", rawParams: AFL() }), src({ eventId: "c", subId3: "t62", keitaroOfferId: null })],
  lookupsWith("ignore"),
);
check("O7 a mixed batch: only the unmarked 170 conversion is dropped", batch.rows.map((r) => r.keitaroEventId).join() === "b,c" && batch.ignored.map((r) => r.keitaroEventId).join() === "a");

console.log("\nglobal pixel switched off later");
const offPixel = buildConversionEventRows(
  [src({ eventId: "x", keitaroType: "lead", keitaroStatus: "lead", rawParams: AFL() }), src({ eventId: "y", rawParams: AFL() })],
  lookupsWith("lead"),
);
check("G1 only marked postbacks arrive ⇒ the setting changes nothing", offPixel.rows.length === 2 && offPixel.rows[0].eventTypeId === LEAD && offPixel.rows[1].eventTypeId === PURCHASE && offPixel.ignored.length === 0);

// ── Source: the setting must not reach who-gets-texted code ────────────────
// It changes what a CONVERSION is (which, through Purchase, already decides who
// is a buyer — the owner accepted that). No lane, tier, send, audience or
// segment file may read the setting itself.
console.log("\nsource");
const ALLOWED = new Set([
  "lib/conversions/build-rows.ts",
  "lib/conversions/ingest.ts",
  "lib/validators/offers.ts",
  "db/schema.ts",
  "app/api/offers/route.ts",
  "app/api/offers/[offerId]/route.ts",
  "app/api/offers/list/route.ts",
  "app/(protected)/offers/page.tsx",
  "components/offers/offer-form.tsx",
]);
const TOKENS = /global_pixel_mode|applyGlobalPixelMode|offerPixelSettings|GLOBAL_PIXEL_MODES|GlobalPixelMode/;
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p.replace(/\\/g, "/")] : [];
  });
const offenders = [...walk("lib"), ...walk("app"), ...walk("components")].filter(
  (f) => !ALLOWED.has(f) && TOKENS.test(readFileSync(f, "utf8")),
);
check("S1 ⭐ only the conversion ledger and the offer form/API read the setting", offenders.length === 0, offenders.join(", "));
const laneFiles = ["lib/campaign-tier.ts", "lib/drip/lifecycle.ts", "lib/sends/eligibility.ts", "lib/segment-rules-eval.ts", "lib/audience-snapshot.ts", "lib/sale-attribution.ts"];
const laneHits = laneFiles.filter((f) => TOKENS.test(readFileSync(f, "utf8")));
check("S2 the named lane / send / audience files are clean", laneHits.length === 0, laneHits.join(", "));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
