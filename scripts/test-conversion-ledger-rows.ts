// Pure checks for lib/conversions/keitaro-row.ts and lib/conversions/build-rows.ts.
// No DB, no network. Run: npx tsx scripts/test-conversion-ledger-rows.ts
import {
  etDayWindows,
  originalConversionTimeEt,
  parseKeitaroLedgerRow,
} from "../lib/conversions/keitaro-row";

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
