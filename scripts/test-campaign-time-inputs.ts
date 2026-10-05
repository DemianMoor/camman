import { readdirSync, readFileSync } from "node:fs";

import {
  CAMPAIGN_TIMEZONE_LABEL,
  campaignLocalInputToUtcIso,
  utcToCampaignLocalInput,
} from "@/lib/campaign-timezone";

// Campaign times are ET everywhere (CLAUDE.md §6). Two ways that breaks, and
// this asserts both.
//
// ⭐ 1. THE CONVERSION. A `datetime-local` value is a bare wall-clock string
// with NO offset, so `new Date(value)` parses it in the BROWSER's zone. On an
// operator's machine in Warsaw that is six hours off ET in summer — and it fails
// silently, because the result is a perfectly valid instant. This was live on
// the Autopilot re-date control: `new Date(redate).toISOString()` sent 07:00Z
// for a typed 09:00, i.e. 03:00 ET.
//
// ⭐ 2. THE LABEL. The conversion can be right and the feature still wrong: a
// datetime-local input renders no zone of its own, so an operator abroad reads
// it as their own clock. Correct storage of the wrong intended hour is still the
// wrong hour.
//
// ⚠️ A SOURCE SCAN IS NOT A SCREEN CHECK. This catches the pattern; it cannot
// prove the label is visible or the field is on the page. The browser pass under
// a non-ET profile is what proves that — see the PR.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(p) : /\.tsx?$/.test(p) ? [p] : [];
  });
}

/** Files holding a datetime-local input — the ones that must play by these rules. */
function filesWithDateTimeInput(): string[] {
  return [...walk("app"), ...walk("components")].filter((f) =>
    readFileSync(f, "utf8").includes('type="datetime-local"'),
  );
}

function main() {
  const files = filesWithDateTimeInput();
  console.log(`${files.length} file(s) render a datetime-local input\n`);

  // ── 1. the conversion is ET, not the runtime's zone ──────────────────────
  // This machine resolves to Europe/Warsaw, so these assertions are meaningful
  // here rather than vacuous.
  console.log(`runtime zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  console.log("⭐ the ET helpers ignore the runtime zone:");
  check("09:00 typed -> 13:00Z (09:00 EDT)",
        campaignLocalInputToUtcIso("2026-10-10T09:00"), "2026-10-10T13:00:00.000Z");
  check("and it round-trips back to 09:00",
        utcToCampaignLocalInput("2026-10-10T13:00:00.000Z"), "2026-10-10T09:00");
  check("winter (EST, UTC-5): 09:00 -> 14:00Z",
        campaignLocalInputToUtcIso("2026-01-10T09:00"), "2026-01-10T14:00:00.000Z");

  // ⭐ the control: show the broken form really is different here, so the
  // assertion above is not trivially true on an ET machine.
  const naive = new Date("2026-10-10T09:00").toISOString();
  const correct = campaignLocalInputToUtcIso("2026-10-10T09:00");
  console.log(`\n  new Date("2026-10-10T09:00") -> ${naive}`);
  console.log(`  campaignLocalInputToUtcIso    -> ${correct}`);
  if (naive === correct) {
    console.log("  (this runtime IS ET, so the two agree — the scan below is what guards it)");
  } else {
    console.log(`  ⭐ they DIFFER here — exactly the silent error this guards against`);
  }

  // ── 2. no file feeds a datetime-local value through `new Date(...)` ──────
  // The payload key is the tell: a timestamp being sent to the API.
  console.log("\n⭐ no datetime-local value is converted with `new Date(...)`:");
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    // `<something>: new Date(<ident>).toISOString()` where the ident is also
    // bound to a datetime-local input in the same file.
    for (const m of src.matchAll(/(\w+):\s*new Date\(\s*(\w+)\s*\)\.toISOString\(\)/g)) {
      const [, key, ident] = m;
      if (new RegExp(`value=\\{${ident}\\}`).test(src)) {
        offenders.push(`${f}: ${key}: new Date(${ident})`);
      }
    }
  }
  check("⭐ no offenders", offenders, []);

  // ── 3. every datetime-local input is labelled ET ─────────────────────────
  // Checked per FILE, not per input: a file may render several fields under one
  // ET heading (the drip Start/End pair shares a note).
  console.log(`\n⭐ every file with a datetime-local input names ${CAMPAIGN_TIMEZONE_LABEL}:`);
  const unlabelled = files.filter((f) => {
    const src = readFileSync(f, "utf8");
    return !src.includes("CAMPAIGN_TIMEZONE_LABEL") && !/\(ET\)/.test(src);
  });
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const ok = src.includes("CAMPAIGN_TIMEZONE_LABEL") || /\(ET\)/.test(src);
    console.log(`     ${ok ? "ET" : "--"}  ${f}`);
  }
  check("⭐ none unlabelled", unlabelled, []);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main();
