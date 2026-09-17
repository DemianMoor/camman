// Pure checks for lib/conversions/keitaro-row.ts and lib/conversions/build-rows.ts.
// No DB, no network. Run: npx tsx scripts/test-conversion-ledger-rows.ts
import {
  etDayWindows,
  originalConversionTimeEt,
  parseKeitaroLedgerRow,
} from "../lib/conversions/keitaro-row";
import {
  buildConversionEventRows,
  resolveMapping,
  type Lookups,
  type MappingRule,
} from "../lib/conversions/build-rows";
import type { LedgerSourceRow } from "../lib/conversions/keitaro-row";
import { ingestKeitaroConversions } from "../lib/conversions/ingest";
import { fetchKeitaroConversionLedger } from "../lib/keitaro/client";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// Shape copied from a live conversions/log row (2026-09-17 probe).
const sweeply = {
  event_id: "019f6639-4c78-7104-8129-376c79e45ef7",
  tid: "",
  sub_id: "2odk4rt.3.snk",
  sub_id_1: "E0E19133-D9CD-4B6C-BD77-294F7ADA505F",
  sub_id_3: "8_62_071426_1_s1_c231",
  status: "lead",
  conversion_type: "Lead",
  revenue: 75,
  datetime: "2026-07-15 10:40:59",
  status_history: "1. Lead (2026-07-15 10:40:59)",
  params: { subid: "2odk4rt.3.snk", status: "lead", payout: "75", currency: "usd", from: "Sweeply.pro" },
  offer_id: 1,
  version: 1,
};

console.log("keitaro-row");
const p = parseKeitaroLedgerRow(sweeply);
check("P1 valid row parses", p !== null);
check("P2 type is the lowercased conversion_type", p?.keitaroType === "lead");
check("P3 revenue is a 4dp string", p?.revenue === "75.0000", String(p?.revenue));
check("P4 currency comes from params, uppercased", p?.currency === "USD");
check("P5 sub_id_1 lowercased (stage_sends ids are lowercase)", p?.subId1 === "e0e19133-d9cd-4b6c-bd77-294f7ada505f");
check("P6 empty tid is null", p?.tid === null);
check("P7 unchanged row: occurred = datetime", p?.occurredAtEt === "2026-07-15 10:40:59" && p?.lastPostbackAtEt === "2026-07-15 10:40:59");

const reposted = parseKeitaroLedgerRow({
  ...sweeply,
  datetime: "2026-09-17 07:13:52",
  status_history: "1. Lead (2026-09-14 21:45:32)",
  version: 2,
});
check("P8 re-posted row keeps the ORIGINAL time", reposted?.occurredAtEt === "2026-09-14 21:45:32", String(reposted?.occurredAtEt));
check("P9 re-posted row records the latest postback", reposted?.lastPostbackAtEt === "2026-09-17 07:13:52");

check(
  "P10 multi-entry history in either order → earliest",
  originalConversionTimeEt("2. Sale (2026-09-20 10:00:00) 1. Lead (2026-09-18 09:00:00)", "2026-09-20 10:00:00") === "2026-09-18 09:00:00",
);
check("P11 no history → datetime", originalConversionTimeEt(null, "2026-09-01 00:00:00") === "2026-09-01 00:00:00");
check("P12 missing event_id → null", parseKeitaroLedgerRow({ ...sweeply, event_id: "" }) === null);
check("P13 missing conversion_type → null", parseKeitaroLedgerRow({ ...sweeply, conversion_type: undefined }) === null);
check("P14 malformed datetime → null", parseKeitaroLedgerRow({ ...sweeply, datetime: "2026-09-17T07:13:52Z" }) === null);
check("P15 Keitaro offer 0 (no offer) → null", parseKeitaroLedgerRow({ ...sweeply, offer_id: 0 })?.keitaroOfferId === null);
check(
  "P16 missing revenue → null (malformed, not $0); explicit 0 still parses",
  parseKeitaroLedgerRow({ ...sweeply, revenue: undefined }) === null &&
    parseKeitaroLedgerRow({ ...sweeply, revenue: null }) === null &&
    parseKeitaroLedgerRow({ ...sweeply, revenue: 0 })?.revenue === "0.0000",
);

const w = etDayWindows("2026-06-01", "2026-06-16 12:00:00", 7);
check(
  "W1 contiguous 7-day ET windows ending at now",
  w.length === 3 &&
    w[0].from === "2026-06-01 00:00:00" && w[0].to === "2026-06-07 23:59:59" &&
    w[1].from === "2026-06-08 00:00:00" && w[1].to === "2026-06-14 23:59:59" &&
    w[2].from === "2026-06-15 00:00:00" && w[2].to === "2026-06-16 12:00:00" &&
    w.every((x) => x.timezone === "America/New_York"),
  JSON.stringify(w),
);

console.log("\nbuild-rows");
const ORG = "00000000-0000-4000-8000-000000000001";
const SEND = "e0e19133-d9cd-4b6c-bd77-294f7ada505f";
const CONTACT = "c0000000-0000-4000-8000-000000000001";
const PURCHASE = 1;
const REGISTRATION = 2;
const rules: MappingRule[] = [
  { offerId: null, affiliateNetworkId: 1, keitaroType: "lead", eventTypeId: PURCHASE, conversionStatus: "approved" }, // swp: lead is paid
  { offerId: null, affiliateNetworkId: 43, keitaroType: "lead", eventTypeId: REGISTRATION, conversionStatus: "approved" }, // psb: lead is a registration
  { offerId: null, affiliateNetworkId: 43, keitaroType: "sale", eventTypeId: PURCHASE, conversionStatus: "approved" },
  { offerId: null, affiliateNetworkId: 43, keitaroType: "registration", eventTypeId: REGISTRATION, conversionStatus: "approved" },
  { offerId: null, affiliateNetworkId: 43, keitaroType: "rejected", eventTypeId: null, conversionStatus: "rejected" },
];

check("M1 network rule applies (psb lead = registration)", JSON.stringify(resolveMapping(rules, { offerId: 134, affiliateNetworkId: 43, keitaroType: "lead" })) === JSON.stringify({ eventTypeId: REGISTRATION, status: "approved" }));
check(
  "M2 offer rule beats network rule",
  resolveMapping(
    [...rules, { offerId: 134, affiliateNetworkId: null, keitaroType: "lead", eventTypeId: PURCHASE, conversionStatus: "pending" }],
    { offerId: 134, affiliateNetworkId: 43, keitaroType: "lead" },
  )?.status === "pending",
);
check("M3 no rule → null", resolveMapping(rules, { offerId: 134, affiliateNetworkId: 43, keitaroType: "trash" }) === null);
check("M4 same type on another network does not leak", resolveMapping(rules, { offerId: 62, affiliateNetworkId: 38, keitaroType: "lead" }) === null);
check("M5 status-only rule keeps a null event type", JSON.stringify(resolveMapping(rules, { offerId: 134, affiliateNetworkId: 43, keitaroType: "rejected" })) === JSON.stringify({ eventTypeId: null, status: "rejected" }));

const lookups: Lookups = {
  stageSends: new Map([[SEND, { stageId: 10, contactId: CONTACT }]]),
  stageIdByTrackingId: new Map([
    ["8_62_071426_1_s1_c231", 10],
    ["143_134_091726_1_s1_c900", 11],
  ]),
  stages: new Map([
    [10, { orgId: ORG, campaignId: 100, offerId: 62, affiliateNetworkId: 1 }],
    [11, { orgId: ORG, campaignId: 101, offerId: 134, affiliateNetworkId: 43 }],
  ]),
  offersByKeitaroId: new Map([[41, { orgId: ORG, offerId: 134, affiliateNetworkId: 43 }]]),
  rulesByOrg: new Map([[ORG, rules]]),
};
const src = (over: Partial<LedgerSourceRow>): LedgerSourceRow => ({
  eventId: "ev-1",
  tid: null,
  clickSubid: "clk",
  subId1: null,
  subId3: null,
  keitaroStatus: "lead",
  keitaroType: "lead",
  revenue: "0.0000",
  currency: "USD",
  occurredAtEt: "2026-09-17 10:00:00",
  lastPostbackAtEt: "2026-09-17 10:00:00",
  keitaroOfferId: null,
  version: 1,
  statusHistory: null,
  rawParams: null,
  ...over,
});

const b1 = buildConversionEventRows([src({ subId1: SEND, subId3: "143_134_091726_1_s1_c900" })], lookups).rows[0];
check(
  "B1 recipient id wins over sub_id_3; stage/campaign/offer from the recipient's stage",
  b1?.stageSendId === SEND && b1.contactId === CONTACT && b1.stageId === 10 && b1.campaignId === 100 && b1.offerId === 62 && b1.orgId === ORG,
  JSON.stringify(b1),
);
check("B2 Sweeply lead → purchase / approved", b1?.eventTypeId === PURCHASE && b1.status === "approved");

const b3 = buildConversionEventRows([src({ subId3: "143_134_091726_1_s1_c900", keitaroType: "registration", keitaroStatus: "registration" })], lookups).rows[0];
check(
  "B3 no recipient, known stage → stage-level row, registration / approved",
  b3?.stageSendId === null && b3.contactId === null && b3.stageId === 11 && b3.offerId === 134 && b3.eventTypeId === REGISTRATION && b3.status === "approved",
  JSON.stringify(b3),
);

const b4 = buildConversionEventRows([src({ subId1: "11111111-1111-4111-8111-111111111111", subId3: "nope", keitaroOfferId: 41, keitaroType: "sale", keitaroStatus: "sale", revenue: "110.0000" })], lookups).rows[0];
check(
  "B4 unknown recipient + unknown stage + mapped Keitaro offer → offer-level row, psb sale → purchase / approved",
  b4?.stageSendId === null && b4.stageId === null && b4.campaignId === null && b4.offerId === 134 && b4.eventTypeId === PURCHASE && b4.status === "approved",
  JSON.stringify(b4),
);

const b5 = buildConversionEventRows([src({ subId3: "nope", keitaroOfferId: 99 })], lookups);
check("B5 nothing resolvable → unresolved, not a row", b5.rows.length === 0 && b5.unresolved.length === 1);

const b6 = buildConversionEventRows([src({ subId1: SEND, keitaroType: "trash", keitaroStatus: "trash" })], lookups).rows[0];
check("B6 unmapped type → NULL event type and NULL status (never a purchase)", b6?.eventTypeId === null && b6.status === null);

const b7 = buildConversionEventRows(
  [src({ subId1: SEND, eventId: "ev-reg", tid: "A", keitaroType: "trash" }), src({ subId1: SEND, eventId: "ev-buy", tid: "B" })],
  lookups,
);
check("B7 two conversions on one click → two rows", b7.rows.length === 2 && b7.rows[0].keitaroEventId !== b7.rows[1].keitaroEventId);

// Truncation guard (user requirement 2026-09-17): a page carrying fewer rows than
// its own `total` must never be handed back as a complete window. fetch is
// stubbed — no network.
async function fetchGuardChecks() {
  console.log("\nfetch truncation guard");
  const realFetch = globalThis.fetch;
  const realKey = process.env.KEITARO_API_KEY;
  process.env.KEITARO_API_KEY = "test-key";
  const stub = (body: unknown) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
  };
  const range = { from: "2026-09-01 00:00:00", to: "2026-09-07 23:59:59", timezone: "America/New_York" };
  try {
    stub({ rows: [{ event_id: "a" }], total: 2 });
    const truncated = await fetchKeitaroConversionLedger(range);
    check(
      "F1 truncated page (rows < total) → not ok, no rows handed back",
      !truncated.ok && truncated.rows.length === 0 && (truncated.error ?? "").includes("truncated: 1 of 2"),
      JSON.stringify(truncated),
    );
    stub({ rows: [{ event_id: "a" }, { event_id: "b" }], total: 2 });
    const whole = await fetchKeitaroConversionLedger(range);
    check("F2 complete page (rows = total) → ok with every row", whole.ok && whole.rows.length === 2 && whole.total === 2, JSON.stringify(whole));

    // Ingest must refuse a truncated window before touching the database.
    stub({ rows: [{ event_id: "a" }], total: 2 });
    const ingTrunc = await ingestKeitaroConversions({} as never, { range });
    check(
      "I1 truncated window → ingest not ok, nothing parsed or written, error names the truncation",
      !ingTrunc.ok && ingTrunc.rows === 0 && ingTrunc.inserted === 0 && ingTrunc.updated === 0 && (ingTrunc.error ?? "").includes("truncated"),
      JSON.stringify(ingTrunc),
    );

    // Unparseable rows are counted and sampled.
    stub({
      rows: [
        { event_id: "", datetime: "2026-09-01 10:00:00", status: "lead", conversion_type: "Lead", revenue: 0 },
        { event_id: "bad-dt", datetime: "2026-09-01T10:00:00Z", status: "lead", conversion_type: "Lead", revenue: 0 },
        { event_id: "no-type", datetime: "2026-09-01 10:00:00", status: "lead", revenue: 0 },
      ],
      total: 3,
    });
    const ingInvalid = await ingestKeitaroConversions({} as never, { range });
    check(
      "I2 unparseable rows are counted and sampled, never silently dropped",
      ingInvalid.ok && ingInvalid.invalid === 3 && ingInvalid.invalidSamples.length === 3 && ingInvalid.rows === 0 &&
        ingInvalid.invalidSamples.some((s) => s.includes("event_id=bad-dt")),
      JSON.stringify(ingInvalid),
    );
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.KEITARO_API_KEY;
    else process.env.KEITARO_API_KEY = realKey;
  }
}

fetchGuardChecks()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
