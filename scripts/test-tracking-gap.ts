// Unit checks for the Keitaro tracking-gap decision rule — pure functions only,
// no DB. Run: npx tsx scripts/test-tracking-gap.ts
//
// Both failure modes are pinned deliberately, because both end with the channel
// muted:
//   - firing when nothing is wrong (a quiet stage, a stage Keitaro DOES see)
//   - NOT firing when something is wrong (the tracking blackout we exist to catch)
import {
  trackingGapBreached,
  hasNoKeitaroVisits,
  TRACKING_GAP_MIN_HUMAN_CLICKS,
  TRACKING_GAP_MATURITY_HOURS,
  TRACKING_GAP_WINDOW_DAYS,
} from "@/lib/reporting/tracking-gap";

let pass = 0,
  fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
}
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual),
    e = JSON.stringify(expected);
  if (a === e) pass++;
  else {
    fail++;
    console.log(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`);
  }
}

// ── the rule ────────────────────────────────────────────────────────────────
ok(
  trackingGapBreached(TRACKING_GAP_MIN_HUMAN_CLICKS, 0),
  "⭐ at the click floor with zero visits -> BREACH",
);
ok(
  trackingGapBreached(315, 0),
  "⭐ stage 3029's real numbers (315 human clicks, 0 visits) -> BREACH",
);
ok(
  !trackingGapBreached(TRACKING_GAP_MIN_HUMAN_CLICKS - 1, 0),
  "below the click floor -> no breach (a handful of clicks is noise, not evidence)",
);
ok(!trackingGapBreached(0, 0), "no clicks and no visits -> no breach (a quiet stage)");
ok(
  !trackingGapBreached(1000, 1),
  "⭐ ONE visit is enough to prove the script fires -> no breach at any click volume",
);
ok(
  !trackingGapBreached(315, 21860),
  "a healthy guidekn-scale stage -> no breach",
);

// Visits are the ONLY Keitaro signal in the rule. Redirects are reported in the
// alert but must never gate it — requiring redirects=0 too would skip 3 of the
// 5 stages that qualify today, all of them the same defect. (The alert's own
// zero-test is exercised above via trackingGapBreached; redirects aren't even
// a parameter, so a redirect-gating regression can't be caught by calling it
// again with the same arguments — see hasNoKeitaroVisits below instead.)

// ── hasNoKeitaroVisits — the shared no-visits predicate (FIX 1) ────────────
//
// BOTH columns, always: raw is a superset of clean (no row in the table has
// clean > raw), so "Keitaro saw visits, none of them unique" (raw > 0,
// clean = 0) must NOT read as a tracking blackout. This is exactly the shape
// that made the Overview mark 56 of 58 flagged stages wrong before the fix.
ok(
  !hasNoKeitaroVisits(1, 0),
  "⭐ raw > 0, clean = 0 is NOT a no-visits state (the script fired; the visits just weren't unique)",
);
ok(hasNoKeitaroVisits(0, 0), "both columns zero -> no visits at all");
ok(!hasNoKeitaroVisits(0, 5), "clean > 0 -> not a no-visits state either");

// ── the thresholds themselves ───────────────────────────────────────────────
eq(TRACKING_GAP_MIN_HUMAN_CLICKS, 25, "click floor is 25 HUMAN clicks");
eq(TRACKING_GAP_MATURITY_HOURS, 6, "maturity is 6h");
eq(TRACKING_GAP_WINDOW_DAYS, 7, "window is 7 days");

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
