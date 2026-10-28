// Pure test of the carrier-rejection code map (lib/carrier-rejection/codes.ts).
// Every code observed on prod 2026-10-24 is listed with the class the owner
// assigned it, so a map edit that moves one turns a bar red.
//
// Run: npx tsx scripts/test-carrier-rejection-codes.ts

import {
  CARRIER_REJECTION_CODES,
  canonicalRejectionCode,
  classifyRejection,
  matchKeys,
  type CarrierRejectionProvider,
  type RejectionClass,
} from "../lib/carrier-rejection/codes";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

const cases: [CarrierRejectionProvider, string | null, RejectionClass | null][] = [
  // Text Request — poll codes and their webhook aliases
  ["txr", "30005", "hard"], ["txr", "2001", "hard"],
  ["txr", "30006", "hard"], ["txr", "2003", "hard"],
  ["txr", "30003", "soft"], ["txr", "1002", "soft"],
  ["txr", "30008", null], ["txr", "3000", null], ["txr", "30004", null],
  ["txr", "30007", null], ["txr", "60005", null], ["txr", "99999", null],
  ["txr", null, null], ["txr", "  ", null],
  // Ahoi — text, case-insensitive and trimmed
  ["ahi", "Invalid destination address", "hard"],
  ["ahi", "  invalid DESTINATION address ", "hard"],
  ["ahi", "Teleservice Not Provisioned", "hard"],
  ["ahi", "Mobile operator not found for the destination address", "hard"],
  ["ahi", "Absent Subscriber", "soft"], ["ahi", "sm delivery failure", "soft"],
  ["ahi", "Invalid client network", null], ["ahi", "Message canceled", null],
  ["ahi", "This message was identified as spam and cannot be delivered", null],
  ["ahi", "000", null],
  // Tells
  ["tls", "Unknown or invalid destination number.", "hard"],
  ["tls", "Landline or unreachable carrier detected.", "hard"],
  ["tls", " destination handset is unreachable. ", "soft"],
  ["tls", "Message filtered by carrier.", null], ["tls", "Network Error", null],
];

console.log("CLASSIFY — every observed code");
for (const [p, raw, want] of cases) {
  const got = classifyRejection(p, raw);
  bar(`${p} ${JSON.stringify(raw)} → ${want ?? "ignore"}`, got === want, got === want ? "" : `got ${got}`);
}

console.log("CANONICAL — one code per failure");
bar("txr 2001 → 30005", canonicalRejectionCode("txr", "2001") === "30005");
bar("txr 1002 → 30003", canonicalRejectionCode("txr", "1002") === "30003");
bar("ahi lower-case → listed casing", canonicalRejectionCode("ahi", " absent subscriber") === "Absent Subscriber");
bar("unlisted kept (trimmed)", canonicalRejectionCode("tls", " Something new ") === "Something new");

console.log("MATCH KEYS — what the ledger SQL matches");
const txrHard = matchKeys("txr", "hard").sort();
bar("txr hard = 2001, 2003, 30005, 30006", JSON.stringify(txrHard) === JSON.stringify(["2001", "2003", "30005", "30006"]), JSON.stringify(txrHard));
bar("txr soft = 1002, 30003", JSON.stringify(matchKeys("txr", "soft").sort()) === JSON.stringify(["1002", "30003"]));
bar("ahi keys are lower-case", matchKeys("ahi", "hard").every((k) => k === k.toLowerCase()));

console.log("SCOPE");
bar("TextHub is not in the map (its DLRs are fabricated)", !("txh" in CARRIER_REJECTION_CODES) && !("txh2" in CARRIER_REJECTION_CODES));
bar("exactly txr, ahi, tls", JSON.stringify(Object.keys(CARRIER_REJECTION_CODES)) === JSON.stringify(["txr", "ahi", "tls"]));
const overlap = (Object.keys(CARRIER_REJECTION_CODES) as CarrierRejectionProvider[]).filter((p) => {
  const h = matchKeys(p, "hard");
  return matchKeys(p, "soft").some((k) => h.includes(k));
});
bar("no code is both hard and soft", overlap.length === 0, overlap.join(","));

console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
