// Pure unit tests for the Telnyx mapping/cost logic (no DB, no network).
// Run: npx tsx scripts/test-telnyx-mapping.ts
import { mapTelnyxLineType, resolveLineType } from "@/lib/telnyx/map-line-type";
import {
  normalizeCarrierName,
  resolveCarrierNorm,
} from "@/lib/telnyx/map-carrier";
import {
  actualLookupCost,
  estimateLookupCost,
} from "@/lib/telnyx/cost";
import { buildLookupRowFromTelnyx } from "@/lib/telnyx/build-lookup-row";
import type { CarrierNorm, TelnyxNumberLookupData } from "@/lib/telnyx/types";

let failures = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ ${msg}\n      expected ${e}\n      got      ${a}`);
  }
}

console.log("\nmapTelnyxLineType — every Telnyx carrier.type enum value:");
eq(mapTelnyxLineType("mobile"), "mobile", "mobile");
eq(mapTelnyxLineType("fixed line"), "landline", "'fixed line' -> landline (NO 'landline' value in Telnyx)");
eq(mapTelnyxLineType("voip"), "voip", "voip");
eq(mapTelnyxLineType("toll free"), "toll_free", "'toll free' -> toll_free");
eq(mapTelnyxLineType("fixed line or mobile"), "unknown", "ambiguous -> unknown (stays eligible)");
eq(mapTelnyxLineType("premium rate"), "unknown", "premium rate -> unknown");
eq(mapTelnyxLineType("pager"), "unknown", "pager -> unknown");
eq(mapTelnyxLineType("MOBILE"), "mobile", "case-insensitive");
eq(mapTelnyxLineType(null), "unknown", "null -> unknown");
eq(mapTelnyxLineType(""), "unknown", "empty -> unknown");

console.log("\nresolveLineType — portability.line_type wins over carrier.type:");
eq(
  resolveLineType({ carrier: { type: "mobile" }, portability: { line_type: "fixed line" } }),
  "landline",
  "port-corrected 'fixed line' overrides carrier 'mobile'",
);
eq(
  resolveLineType({ carrier: { type: "mobile" }, portability: { line_type: "" } }),
  "mobile",
  "empty portability falls back to carrier.type",
);
eq(resolveLineType({ carrier: { type: "voip" } }), "voip", "no portability -> carrier.type");

console.log("\nnormalizeCarrierName — matching canonicalization:");
eq(normalizeCarrierName("  T-Mobile   USA, Inc. "), "t-mobile usa, inc.", "trim+collapse+lowercase");

console.log("\nresolveCarrierNorm:");
const mappings = new Map<string, CarrierNorm>([
  [normalizeCarrierName("Cellco Partnership dba Verizon Wireless"), "Verizon"],
  [normalizeCarrierName("T-Mobile USA, Inc."), "T-Mobile"],
  [normalizeCarrierName("Telnyx LLC"), "VoIP"],
]);
eq(resolveCarrierNorm("Cellco Partnership DBA Verizon Wireless", mappings), "Verizon", "case-insensitive match -> Verizon");
eq(resolveCarrierNorm("T-Mobile USA, Inc.", mappings), "T-Mobile", "exact -> T-Mobile");
eq(resolveCarrierNorm("Some Random Telco LLC", mappings), "Unmapped", "unmatched present string -> Unmapped");
eq(resolveCarrierNorm(null, mappings), "Unknown", "no carrier info -> Unknown (not Unmapped)");
eq(resolveCarrierNorm("   ", mappings), "Unknown", "blank -> Unknown");

console.log("\ncost math (base=0.0015, mobile=0.0025):");
const rates = { base: 0.0015, mobile: 0.0025 };
eq(estimateLookupCost(0, rates), 0, "0 lookups -> $0");
eq(estimateLookupCost(1000, rates, 0), 1.5, "1000 @ 0% mobile -> base only $1.50");
eq(estimateLookupCost(1000, rates, 1), 4, "1000 @ 100% mobile -> $4.00");
eq(estimateLookupCost(1000, rates, 0.35), 2.375, "1000 @ 35% mobile -> $2.375");
eq(actualLookupCost({ mobile: 310, landline: 380, voip: 170, unknown: 140 }, rates), round4(1000 * 0.0015 + 310 * 0.0025), "actual: base on all + mobile surcharge on 310");
eq(actualLookupCost({ landline: 500 }, rates), 0.75, "all landline -> base only, no surcharge");

console.log("\nbuildLookupRowFromTelnyx — Telnyx's published VOIP example (Telnyx/4):");
const voipData: TelnyxNumberLookupData = {
  record_type: "number_lookup",
  phone_number: "+13129457420",
  carrier: { name: "Telnyx/4", type: "voip", mobile_network_code: 866 },
  portability: { lrn: "2245701999", ocn: "073H", spid: "073H", ported_status: "Y", ported_date: "2017-10-20", line_type: "voip" },
};
const voipRow = buildLookupRowFromTelnyx("+13129457420", voipData, mappings);
eq(voipRow.line_type, "voip", "line_type voip");
eq(voipRow.carrier_raw, "Telnyx/4", "carrier_raw preserved");
eq(voipRow.carrier_norm, "Unmapped", "'Telnyx/4' not in seed -> Unmapped");
eq(voipRow.ocn, "073H", "ocn");
eq(voipRow.spid, "073H", "spid");
eq(voipRow.ported, true, "ported_status 'Y' -> true");
eq(voipRow.ported_date, "2017-10-20", "ported_date");
eq(voipRow.source, "telnyx", "source telnyx");

console.log("\nbuildLookupRowFromTelnyx — mobile Verizon (port-corrected landline check):");
const mobileData: TelnyxNumberLookupData = {
  carrier: { name: "Cellco Partnership DBA Verizon Wireless", type: "mobile" },
  portability: { ocn: "6180", spid: "6180", ported_status: "N", line_type: "mobile" },
};
const mobileRow = buildLookupRowFromTelnyx("+14155552671", mobileData, mappings);
eq(mobileRow.line_type, "mobile", "line_type mobile");
eq(mobileRow.carrier_norm, "Verizon", "resolved to Verizon");
eq(mobileRow.ported, false, "ported_status 'N' -> false");

console.log("\nbuildLookupRowFromTelnyx — landline (the hard-stop case):");
const landlineRow = buildLookupRowFromTelnyx(
  "+12125551234",
  { carrier: { name: "PACIFIC BELL", type: "fixed line" } },
  mappings,
);
eq(landlineRow.line_type, "landline", "'fixed line' -> landline (=> not_applicable downstream)");
eq(landlineRow.carrier_raw, "PACIFIC BELL", "landline carrier_raw still kept for audit");
eq(landlineRow.carrier_norm, "Unknown", "landline carrier_norm -> Unknown (not Unmapped — keeps queue actionable)");

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

console.log(
  failures === 0
    ? "\nAll Telnyx mapping tests passed ✅"
    : `\nFAILED: ${failures} assertion(s) ✗`,
);
process.exit(failures === 0 ? 0 : 1);
