import "./_env-preload";

import {
  findGaps,
  MAX_FIRST_SEND_STAGES,
  minutesToLabel,
  pickStage,
  validateWindowSet,
  type StageWindow,
} from "@/lib/drip/windows";

// Drip stage window rules (Drip Phase 5). Pure functions — no database.
//
// ⭐ THE TOUCHING CASE IS THE POINT. 09:30–14:00 followed by 14:00–18:30 LOOKS
// correct and is the natural thing an operator types. It is an error, because
// the minute 14:00 would belong to two stages at once and the spec's "exactly
// ONE first-send" rule then has no answer for a lead arriving exactly then.
// A validator that only caught genuine overlaps would pass this and the bug
// would surface as a duplicate message, weeks later.
//
// ⭐ AND THE SAME FUNCTION RUNS ON BOTH SIDES. The editor and the save endpoint
// both call validateWindowSet, so the wording an operator reads while typing is
// the wording that refuses the save. A server-only copy would drift.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const w = (id: number, s: number, e: number): StageWindow => ({
  stage_id: id, window_start_min: s, window_end_min: e,
});

const HH = (h: number, m = 0) => h * 60 + m;

function main() {
  console.log("valid sets:");
  check("two clearly separated windows are fine",
        validateWindowSet([w(1, HH(9, 30), HH(14)), w(2, HH(14, 1), HH(18, 30))]).length, 0);
  check("a single window is fine", validateWindowSet([w(1, HH(9), HH(17))]).length, 0);
  check("an empty set is fine", validateWindowSet([]).length, 0);
  check("the full day is fine", validateWindowSet([w(1, 0, 1440)]).length, 0);

  console.log("\n⭐ touching — the case that looks right and is not:");
  const touching = validateWindowSet([w(1, HH(9, 30), HH(14)), w(2, HH(14), HH(18, 30))]);
  check("09:30–14:00 + 14:00–18:30 is REFUSED", touching.length, 1);
  check("...reported as 'touch', not 'overlap'", touching[0]?.kind, "touch");
  check("...and the message suggests the fix",
        /13:59|14:01/.test(touching[0]?.message ?? ""), true);

  console.log("\noverlap:");
  const overlap = validateWindowSet([w(1, HH(9), HH(15)), w(2, HH(14), HH(18))]);
  check("09:00–15:00 + 14:00–18:00 is REFUSED", overlap.length, 1);
  check("...reported as 'overlap'", overlap[0]?.kind, "overlap");

  console.log("\ninvalid single windows:");
  check("zero-length is refused", validateWindowSet([w(1, 600, 600)])[0]?.kind, "invalid");
  check("end before start is refused", validateWindowSet([w(1, 800, 600)])[0]?.kind, "invalid");
  check("past the end of the day is refused", validateWindowSet([w(1, 100, 1441)])[0]?.kind, "invalid");
  check("negative start is refused", validateWindowSet([w(1, -1, 100)])[0]?.kind, "invalid");

  console.log("\nstage count:");
  const six = Array.from({ length: 6 }, (_, i) => w(i, i * 100, i * 100 + 50));
  check(`more than ${MAX_FIRST_SEND_STAGES} stages is refused`,
        validateWindowSet(six).some((p) => p.kind === "too_many"), true);
  const five = Array.from({ length: 5 }, (_, i) => w(i, i * 100, i * 100 + 50));
  check(`exactly ${MAX_FIRST_SEND_STAGES} is allowed (control)`, validateWindowSet(five).length, 0);

  console.log("\ngaps WARN, never block:");
  const gaps = findGaps([w(1, HH(9), HH(12)), w(2, HH(15), HH(18))]);
  check("a 3-hour gap is reported", gaps.length, 1);
  check("...with the size in minutes", gaps[0]?.minutes, 180);
  check("⭐ but the set is still VALID (a gap is legal)",
        validateWindowSet([w(1, HH(9), HH(12)), w(2, HH(15), HH(18))]).length, 0);
  check("adjacent-by-one-minute is not a gap",
        findGaps([w(1, HH(9), HH(12)), w(2, HH(12, 1), HH(18))]).length, 0);

  console.log("\nstage picking (half-open [start, end)):");
  const set = [w(10, HH(9), HH(12)), w(20, HH(13), HH(18))];
  check("inside the first window ⇒ that stage, fires now",
        pickStage(set, HH(10)), { stage_id: 10, opens_at_min: null });
  check("⭐ exactly at `end` belongs to the NEXT window, not this one",
        pickStage(set, HH(12))?.stage_id, 20);
  check("...and it waits rather than firing", pickStage(set, HH(12))?.opens_at_min, HH(13));
  check("exactly at `start` IS inside", pickStage(set, HH(9))?.opens_at_min, null);
  check("between windows ⇒ next opening",
        pickStage(set, HH(12, 30)), { stage_id: 20, opens_at_min: HH(13) });
  check("after every window ⇒ tomorrow's first",
        pickStage(set, HH(23)), { stage_id: 10, opens_at_min: HH(9) });
  check("before every window ⇒ today's first",
        pickStage(set, HH(6)), { stage_id: 10, opens_at_min: HH(9) });
  check("no stages ⇒ null", pickStage([], HH(10)), null);

  console.log("\nlabels:");
  check("minutes render as HH:MM", minutesToLabel(HH(9, 5)), "09:05");
  check("midnight renders as 00:00", minutesToLabel(0), "00:00");

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main();
