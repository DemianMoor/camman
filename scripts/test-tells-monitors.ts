// Unit checks for the Tells monitor decision rules (Phase 4) — pure functions
// only, no DB. Run: npx tsx scripts/test-tells-monitors.ts
//
// These monitors are the SOLE detection layer for broken STOP intake, so the
// rules that decide whether an alert fires are pinned here. Both failure modes
// are covered deliberately, because both end with the channel muted:
//   - firing when nothing is wrong (the 2-vs-1 DLR counting trap, low volume)
//   - NOT firing when something is wrong (the compliance failure)
import {
  expectedDlrEvents,
  dlrCoverageBreached,
  inboundSilenceBreached,
  DLR_COVERAGE_MIN_RATIO,
  DLR_COVERAGE_MIN_SENDS,
  INBOUND_SILENCE_MIN_SENDS,
  UNDELIVERED_TRIPWIRE_RATIO,
  undeliveredTripwireBreached,
} from "@/lib/sends/tells-monitors";

let pass = 0, fail = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; } else { fail++; console.log(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`); }
}
function ok(cond: boolean, label: string) { if (cond) pass++; else { fail++; console.log(`  ✗ ${label}`); } }

// ===========================================================================
// ⭐ THE COUNTING RULE — 2 events per success, 1 per failure (§4.5)
// ===========================================================================
eq(expectedDlrEvents(0, 0), 0, "counting: nothing sent -> 0 expected events");
eq(expectedDlrEvents(1, 0), 2, "⭐ counting: ONE delivered message expects TWO events (sent + delivered)");
eq(expectedDlrEvents(0, 1), 1, "⭐ counting: ONE failed message expects ONE event (undelivered, no preceding sent)");
eq(expectedDlrEvents(10, 0), 20, "counting: 10 delivered -> 20");
eq(expectedDlrEvents(0, 10), 10, "counting: 10 undelivered -> 10");
eq(expectedDlrEvents(90, 10), 190, "⭐ counting: mixed batch 90 ok + 10 failed -> 190, NOT 200");
// The naive assumption this rule exists to prevent:
ok(expectedDlrEvents(90, 10) !== 2 * (90 + 10),
   "⭐ counting: differs from the naive 2-per-message assumption (which would read every failure as a gap)");

// ===========================================================================
// DLR coverage — messages with >=1 terminal event, over matured sends
// ===========================================================================
// Volume floor: never alert on noise.
ok(!dlrCoverageBreached(0, 0), "coverage: zero sends -> no breach");
ok(!dlrCoverageBreached(DLR_COVERAGE_MIN_SENDS - 1, 0),
   "coverage: below the volume floor -> NO breach even at 0% (a ratio over a handful is noise)");
// At/above the floor the ratio governs.
ok(dlrCoverageBreached(DLR_COVERAGE_MIN_SENDS, 0),
   "coverage: at the floor with zero coverage -> BREACH");
ok(!dlrCoverageBreached(100, 100), "coverage: 100% -> no breach");
ok(!dlrCoverageBreached(100, 90), "coverage: exactly at the threshold (90%) -> no breach");
ok(dlrCoverageBreached(100, 89), "coverage: just under the threshold (89%) -> BREACH");
ok(dlrCoverageBreached(1000, 500), "coverage: 50% at volume -> BREACH");
eq(DLR_COVERAGE_MIN_RATIO, 0.9, "coverage: threshold is 90% (proposed; calibrated in Phase 5)");

// ⭐ The regression this design exists to prevent: an all-FAILED batch still
// has full COVERAGE (every message has a terminal `undelivered` event), so it
// must NOT breach — even though it produces only half the events a
// 2-per-message monitor would expect.
ok(!dlrCoverageBreached(100, 100),
   "⭐ coverage: 100 messages ALL FAILED but all with a terminal event -> NO breach");
ok(expectedDlrEvents(0, 100) === 100,
   "⭐ coverage: ...and that batch legitimately produces 100 events, not 200");

// =====================================================================
// ⭐ FIELD DATA — the real 2026-08-13 validation send, 500 messages.
// Not synthetic: these are the numbers production actually produced, kept as a
// regression fixture so a future change to the counting rule has to explain
// itself against observed reality.
//   sent 500 · delivered 451 · undelivered 29 · >=1 terminal 480 · 961 events
// =====================================================================
const REAL = { sent: 500, delivered: 451, undelivered: 29, covered: 480, actualEvents: 961 };
eq(expectedDlrEvents(REAL.delivered, REAL.undelivered), 931,
   "⭐ field: expected events = 2x451 + 1x29 = 931");
ok(REAL.actualEvents > expectedDlrEvents(REAL.delivered, REAL.undelivered),
   "field: actual (961) exceeds expected (931) by the in-flight `sent`-only events — not a gap");
ok(!dlrCoverageBreached(REAL.sent, REAL.covered),
   "⭐ field: 96.0% coverage did NOT breach the 90% threshold");
// The whole point of the counting rule, in one assertion:
ok(2 * REAL.sent === 1000 && 2 * REAL.sent > REAL.actualEvents,
   "⭐ field: a naive 2-per-message monitor would expect 1000, see 961, and report a ~4% gap that DOES NOT EXIST");

// ===========================================================================
// Inbound silence — the compliance-critical monitor
// ===========================================================================
ok(!inboundSilenceBreached(0, 0), "silence: no sends, no inbound -> no breach (nothing happened)");
ok(!inboundSilenceBreached(INBOUND_SILENCE_MIN_SENDS - 1, 0),
   "silence: below the send floor with zero inbound -> no breach (could be a quiet day)");
ok(inboundSilenceBreached(INBOUND_SILENCE_MIN_SENDS, 0),
   "⭐ silence: at the send floor with ZERO inbound -> BREACH (intake is broken)");
ok(inboundSilenceBreached(50_000, 0), "silence: heavy volume, zero inbound -> BREACH");
ok(!inboundSilenceBreached(50_000, 1),
   "silence: a SINGLE inbound event proves the pipe is alive -> no breach");
ok(!inboundSilenceBreached(INBOUND_SILENCE_MIN_SENDS, 3), "silence: some inbound -> no breach");
// CALIBRATED from the validation send's observed 0.40% STOP rate:
// ln(0.01)/ln(1-0.004) ≈ 1149 sends for 99% confidence that zero STOPs is breakage.
eq(INBOUND_SILENCE_MIN_SENDS, 1200, "silence: floor is 1200 sends (calibrated 2026-08-13)");
ok(INBOUND_SILENCE_MIN_SENDS >= 1149,
   "⭐ silence: floor clears the 99%-confidence bound implied by the observed 0.40% STOP rate");
// The validation send itself (500 sends, 4 inbound) must NOT have breached —
// both because inbound arrived and because 500 is under the floor.
ok(!inboundSilenceBreached(500, 4), "silence: the 2026-08-13 validation send did not breach");
ok(!inboundSilenceBreached(500, 0), "silence: 500 sends is below the floor, so silence alone is not a breach");

// ===========================================================================
// ⭐ UNDELIVERED TRIPWIRE (runbook §2b) — carrier filtering surfaces as
// `undelivered`, never as an API error, so this is the signal that a young
// toll-free number is decaying while the API layer still looks perfectly healthy.
//
// The threshold is calibrated to ONE number (tls TFN, 5.8% at 5/s). Both failure
// modes are pinned, for the same reason as the rules above: a monitor that fires
// on a healthy baseline gets muted, and a monitor that stays quiet through real
// carrier filtering is worse than none.
// ===========================================================================
console.log("\nundelivered tripwire:");
ok(!undeliveredTripwireBreached(500, 29), "⭐ the 5.8% observed baseline does NOT breach");
ok(!undeliveredTripwireBreached(1000, 80), "exactly 8.0% does not breach (strictly greater)");
ok(undeliveredTripwireBreached(1000, 81), "⭐ 8.1% breaches");
ok(undeliveredTripwireBreached(500, 100), "20% — obvious carrier filtering — breaches");
ok(!undeliveredTripwireBreached(DLR_COVERAGE_MIN_SENDS - 1, DLR_COVERAGE_MIN_SENDS - 1),
   "below the volume floor a 100% rate is noise, not a breach");
ok(undeliveredTripwireBreached(DLR_COVERAGE_MIN_SENDS, DLR_COVERAGE_MIN_SENDS),
   "at the volume floor a 100% rate DOES breach");
ok(!undeliveredTripwireBreached(0, 0), "zero sends never breaches (no divide-by-zero alert)");
eq(UNDELIVERED_TRIPWIRE_RATIO, 0.08, "threshold is the runbook's 8%");

console.log(`\n${fail === 0 ? "✓ ALL PASS" : "✗ FAILED"}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
