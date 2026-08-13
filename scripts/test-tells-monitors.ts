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
eq(INBOUND_SILENCE_MIN_SENDS, 2000, "silence: floor is 2000 sends (proposed; calibrated in Phase 5)");

console.log(`\n${fail === 0 ? "✓ ALL PASS" : "✗ FAILED"}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
