// CARRY 2: Ahoi's inbound/DLR source/destination fields are 10-digit, no +1
// (Phase 0 recon). Contacts are stored E.164. ahoiSourceToE164 is the
// inverse of toAhoiRecipient — self-contained regex (NOT via
// validatePhone/libphonenumber-js, which throws under tsx). Both directions
// must round-trip cleanly.
// Run: npx tsx scripts/test-ahoi-e164-roundtrip.ts
import { ahoiSourceToE164, toAhoiRecipient } from "@/lib/sends/providers/ahoi";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

check(
  "10-digit -> E.164",
  ahoiSourceToE164("5642155963") === "+15642155963",
  ahoiSourceToE164("5642155963") ?? "null",
);
check(
  "round trip: E.164 -> 10-digit (toAhoiRecipient) -> E.164 (ahoiSourceToE164) reproduces the original",
  ahoiSourceToE164(toAhoiRecipient("+15642155963")) === "+15642155963",
);
check(
  "round trip: a DIFFERENT number also survives",
  ahoiSourceToE164(toAhoiRecipient("+13158359592")) === "+13158359592",
);
check(
  "11-digit with leading 1 also normalizes (defensive)",
  ahoiSourceToE164("15642155963") === "+15642155963",
);
check("too few digits -> null (invalid NANP number)", ahoiSourceToE164("12345") === null);
check("empty string -> null", ahoiSourceToE164("") === null);
check("non-numeric junk -> null", ahoiSourceToE164("not-a-phone") === null);
check(
  "alphanumeric junk that digit-strips to a coincidental 10-digit sequence -> null",
  ahoiSourceToE164("+1zzztest138438531") === null,
  ahoiSourceToE164("+1zzztest138438531") ?? "null",
);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
