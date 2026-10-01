import { validatePhone } from "@/lib/phone-validation";
import { prepareLead } from "@/lib/intake/capture";

// Sandbox accepts an unassigned area code; live does not.
//
// ⚠️ RUN WITH `--conditions=import`:
//     npx tsx --conditions=import scripts/test-sandbox-phone-validation.ts
// Under tsx's default CJS resolution libphonenumber-js loads its metadata JSON
// as a module namespace rather than an object and throws inside
// isSupportedCountry(). That is a harness artifact, not a product bug — Next.js
// resolves the ESM build. Every script that CALLS validatePhone needs this flag.
//
// ⭐ WHAT THIS HAS TO PROVE, in order of what would hurt most if wrong:
//   1. LIVE IS UNCHANGED. The relaxation must not leak into the 21 other callers
//      — provider-phone registration, the opt-out path, the paid Telnyx lookups.
//      Asserted via the DEFAULT mode, because that is what those callers use.
//   2. Sandbox accepts the number the partner actually sent.
//   3. Sandbox still rejects malformed input, so the rejection path a partner
//      is meant to exercise still exists.
//   4. Normalization is identical in both modes, so duplicate detection keeps
//      working in sandbox. This is the one that makes the feature worth having
//      rather than actively misleading.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const SANDBOX_KEY = {
  field_mapping: {}, interest_tag_mode: "default" as const,
  interest_tag: null, sandbox: true,
};
const LIVE_KEY = { ...SANDBOX_KEY, sandbox: false };
const AT = new Date("2026-10-01T12:00:00Z");

function main() {
  // ── 1. live is unchanged ────────────────────────────────────────────────
  console.log("⭐ LIVE (and every other caller — the default mode) is unchanged:");
  check("default mode rejects the unassigned area code 555",
        validatePhone("+15555550100").valid, false);
  check("explicit strict rejects it too",
        validatePhone("+15555550100", "US", "strict").valid, false);
  check("⭐ the DEFAULT is strict (the 21 other callers pass no mode)",
        validatePhone("+15555550100", "US").valid,
        validatePhone("+15555550100", "US", "strict").valid);
  check("live still accepts a real assigned number",
        validatePhone("+12025550199").valid, true);

  // ── 2. sandbox accepts an unassigned area code ──────────────────────────
  console.log("\n⭐ SANDBOX accepts a well-formed number with an unassigned area code:");
  for (const n of ["+15555550100", "5555550100", "555-555-0100", "(555) 555-0100"]) {
    check(`format_only accepts ${n}`, validatePhone(n, "US", "format_only").valid, true);
  }
  check("and other unassigned area codes (999)",
        validatePhone("+19995551234", "US", "format_only").valid, true);

  // ── 3. sandbox still rejects malformed input ────────────────────────────
  console.log("\n⭐ SANDBOX still rejects malformed input — the rejection path survives:");
  for (const [n, why] of [
    ["+1202555019", "9 digits — too short"],
    ["+120255501999", "12 digits — too long"],
    ["+120255510999", "13 digits"],
    ["abc", "not a number"],
    ["", "empty"],
    ["12", "far too short"],
  ] as [string, string][]) {
    check(`format_only rejects "${n}" (${why})`,
          validatePhone(n, "US", "format_only").valid, false);
  }

  // ── 4. normalization is identical — dedup integrity ─────────────────────
  // ⭐ If the spellings normalized differently, the same lead resubmitted would
  // get a different dedup key and come back duplicate:false. Step 3 of the
  // documented sandbox sequence is "resubmit → duplicate:true", so a divergent
  // normalizer here would make us look broken at exactly the step this feature
  // is meant to smooth.
  console.log("\n⭐ every spelling normalizes to ONE E.164 (duplicate detection):");
  const forms = ["+15555550100", "5555550100", "555-555-0100", "(555) 555-0100", "555.555.0100"];
  const normalized = [...new Set(forms.map((f) => validatePhone(f, "US", "format_only").normalized))];
  check("all spellings collapse to a single E.164", normalized, ["+15555550100"]);
  check("and it is a real E.164 string, not the raw input",
        normalized[0] !== "555-555-0100" && normalized[0]!.startsWith("+1"), true);

  // ── 5. prepareLead routes on key.sandbox, both directions ───────────────
  console.log("\n⭐ prepareLead honours key.sandbox:");
  const sandboxLead = prepareLead({ phone: "+15555550100" }, SANDBOX_KEY, AT);
  check("sandbox key -> received", sandboxLead.status, "received");
  check("sandbox key -> phone normalized to E.164", sandboxLead.phone_e164, "+15555550100");
  check("⭐ sandbox key -> dedup key present (so retries dedupe)",
        typeof sandboxLead.dedup_key === "string" && sandboxLead.dedup_key.length > 0, true);

  const liveLead = prepareLead({ phone: "+15555550100" }, LIVE_KEY, AT);
  check("⭐ live key -> rejected", liveLead.status, "rejected");
  check("live key -> no phone stored", liveLead.phone_e164, null);
  check("live key -> no dedup key", liveLead.dedup_key, null);

  // the error no longer says the same thing twice
  check("⭐ error is not doubled", liveLead.error, "Invalid phone number");

  // a malformed number is still rejected on a SANDBOX key
  const sandboxBad = prepareLead({ phone: "+1202555019" }, SANDBOX_KEY, AT);
  check("sandbox key + malformed -> still rejected", sandboxBad.status, "rejected");

  // a real number works on both
  for (const [label, key] of [["sandbox", SANDBOX_KEY], ["live", LIVE_KEY]] as const) {
    const r = prepareLead({ phone: "202-555-0199" }, key, AT);
    check(`${label} key + real number -> received, normalized`,
          [r.status, r.phone_e164], ["received", "+12025550199"]);
  }

  // ── 6. the same lead twice in a minute shares a dedup key ───────────────
  const a = prepareLead({ phone: "+15555550100" }, SANDBOX_KEY, AT);
  const b = prepareLead({ phone: "555-555-0100" }, SANDBOX_KEY, AT);
  check("⭐ two spellings, same minute -> SAME dedup key", a.dedup_key, b.dedup_key);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main();
