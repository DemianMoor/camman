// Guard: the phone normalizers never disagree about WHICH E.164 a number is.
// Contact-blocks spec (docs/superpowers/specs/2026-11-06-contact-blocks-soft-delete-design.md)
// §9 / owner decision O9.
//
// The contact_blocks ledger and every import check key on validatePhone's E.164.
// The three provider STOP normalizers (ahoiSourceToE164, tellsPhoneToE164,
// textrequestPhoneToE164) are hand-rolled NANP regexes. They are deliberately
// LOOSER — they accept unassigned NANP numbers (555, area codes starting 0/1)
// that strict validatePhone rejects, because dropping a real STOP is a compliance
// regression. That looseness is allowed. What is NOT allowed is producing a
// DIFFERENT E.164 for the same input: then a STOP would land on a contact the
// block check never matches.
//
// Bars:
//   N1 for every fixture where validatePhone is non-null, each STOP normalizer
//      returns null or the same string.
//   N2 the looseness is exactly what we think it is (documents it, so a future
//      change that makes them stricter or looser shows up here).
//   N3 lib/imports/parse-csv.ts normalizes through validatePhone and no longer
//      calls libphonenumber itself (one normalizer).
// No database. Runs in check:guards.
//
// ⚠️ validatePhone is evaluated in a CHILD `node` process (Node's native
// TypeScript stripping), not here: libphonenumber-js mis-loads its metadata
// under tsx ("Cannot read properties of undefined (reading 'hasOwnProperty')"),
// which is why other scripts stub it. Stubbing would defeat this guard, so the
// real validatePhone runs where it works. lib/phone-validation.ts must stay
// loadable that way (no path aliases); if it stops, this guard fails loudly.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ahoiSourceToE164 } from "@/lib/sends/providers/ahoi";
import { tellsPhoneToE164 } from "@/lib/sends/providers/tells";
import { textrequestPhoneToE164 } from "@/lib/sends/providers/textrequest";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

// Spellings of real-looking US numbers, plus junk, wrong lengths, non-US.
const FIXTURES = [
  "+12025550199", "12025550199", "2025550199", "(202) 555-0199", "202-555-0199",
  "202.555.0199", "+1 202 555 0199", " 2025550199 ", "1-202-555-0199", "+1 (202) 555-0199",
  "+13306017528", "3306017528", "13306017528", "+1 330 601 7528",
  "+17185551234", "7185551234", "+19175550123", "9175550123",
  "+14155552671", "4155552671", "+13105551234", "3105551234",
  // unassigned / impossible NANP shapes — STOP normalizers accept, strict rejects
  "5555550100", "+15555550100", "0125550199", "1125550199",
  // wrong lengths
  "202555019", "202555019999", "+1202555019",
  // non-US
  "+442071838750", "+33142685300", "+61293744000",
  // junk
  "", "abc", "+1zzz2025550199", "202-555-01ab",
];
const STOP: [string, (s: string) => string | null][] = [
  ["ahoiSourceToE164", ahoiSourceToE164],
  ["tellsPhoneToE164", tellsPhoneToE164],
  ["textrequestPhoneToE164", textrequestPhoneToE164],
];

function validatePhoneAll(inputs: string[]): (string | null)[] {
  const code = `import("./lib/phone-validation.ts").then((m) => {
    const inputs = JSON.parse(process.argv[1]);
    process.stdout.write(JSON.stringify(inputs.map((i) => m.validatePhone(i).normalized ?? null)));
  })`;
  const out = execFileSync(process.execPath, ["--no-warnings", "-e", code, JSON.stringify(inputs)], {
    cwd: process.cwd(), encoding: "utf8",
  });
  return JSON.parse(out) as (string | null)[];
}

function main() {
  console.log("PART N — phone normalizer agreement");
  const strict = validatePhoneAll(FIXTURES);
  const validatePhone = (i: string) => ({ normalized: strict[FIXTURES.indexOf(i)] ?? null });
  const conflicts: string[] = [];
  for (const input of FIXTURES) {
    const v = validatePhone(input).normalized ?? null;
    if (v === null) continue;
    for (const [name, fn] of STOP) {
      const s = fn(input);
      if (s !== null && s !== v) conflicts.push(`${name}(${JSON.stringify(input)}) = ${s}, validatePhone = ${v}`);
    }
  }
  bar("N1 no STOP normalizer yields a DIFFERENT E.164 than validatePhone", conflicts.length === 0, conflicts.slice(0, 5).join("; "));

  const looser = ["5555550100", "+15555550100"].every(
    (i) => validatePhone(i).normalized == null && STOP.every(([, fn]) => fn(i) === "+15555550100"),
  );
  const nonUsRejected = ["+442071838750"].every((i) => STOP.every(([, fn]) => fn(i) === null));
  bar("N2 documented looseness: unassigned NANP accepted by STOP normalizers only; non-US rejected by them", looser && nonUsRejected);

  const src = readFileSync(resolve(process.cwd(), "lib/imports/parse-csv.ts"), "utf8");
  bar("N3 parse-csv normalizes via validatePhone, no direct libphonenumber call",
    /validatePhone\(/.test(src) && !/from "libphonenumber-js"/.test(src) && !/parsePhoneNumberFromString\(/.test(src));

  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
