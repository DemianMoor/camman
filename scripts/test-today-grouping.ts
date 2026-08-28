import { groupStagesByPhone, isNeedsAction } from "@/lib/sends/group-stages-by-phone";
import { STAGE_STATUS_ORDER } from "@/lib/stages/stage-status";
import type { StageOperationalStatus } from "@/lib/stages/stage-status";

let fails = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) fails++;
};

const mk = (
  phone: number | null,
  status: StageOperationalStatus,
  scheduled: string | null,
  tag: string,
) => ({
  provider_phone_id: phone,
  phone_number: phone ? `+1844000000${phone}` : null,
  number_type: "toll_free",
  provider_name: `P${phone}`,
  provider_color: null,
  provider_paused: false,
  scheduled_at: scheduled,
  operational_status: status,
  counts: { total: 10, sent: 3 },
  tag,
});

// --- band membership -------------------------------------------------------
const band = STAGE_STATUS_ORDER.filter(isNeedsAction).sort();
ok(
  `needs-action band is exactly the 4 attention states (got: ${band.join(",")})`,
  JSON.stringify(band) ===
    JSON.stringify(["blocked", "held", "missed_failed", "scheduled_unprepared"]),
);
ok("skipped_empty is NOT in the band", !isNeedsAction("skipped_empty"));
ok("draft is NOT in the band", !isNeedsAction("draft"));
ok("sending_sent is NOT in the band", !isNeedsAction("sending_sent"));

// --- ordering within a block ----------------------------------------------
const t = (h: number) => `2026-08-28T${String(h).padStart(2, "0")}:00:00Z`;
const stages = [
  mk(1, "sending_sent", t(9), "sent-9"),
  mk(1, "skipped_empty", t(8), "empty-8"), // benign, must sink despite earliest time
  mk(1, "missed_failed", t(14), "red-14"),
  mk(1, "prepared", t(10), "prep-10"),
  mk(1, "scheduled_unprepared", t(12), "orange-12"),
  mk(1, "blocked", t(11), "rose-11"),
];
const g1 = groupStagesByPhone(stages)[0];
const order = g1.stages.map((s) => s.tag);
ok(
  `band on top, time-ascending within each band (got: ${order.join(" | ")})`,
  JSON.stringify(order) ===
    JSON.stringify(["rose-11", "orange-12", "red-14", "empty-8", "sent-9", "prep-10"]),
);
ok(
  "skipped_empty stays out of the band (sorts by time with the rest)",
  order.indexOf("empty-8") > order.indexOf("red-14"),
);

// --- group ordering + null bucket -----------------------------------------
const multi = [
  mk(2, "prepared", t(7), "quiet-early"),      // no action, earliest
  mk(3, "scheduled_unprepared", t(15), "needs"), // action, latest
  mk(null, "prepared", t(6), "orphan"),          // null bucket, earliest of all
];
const gs = groupStagesByPhone(multi);
ok(
  `needs-action group first, null bucket last (got: ${gs.map((g) => g.key).join(",")})`,
  JSON.stringify(gs.map((g) => g.key)) ===
    JSON.stringify(["phone-3", "phone-2", "no-phone"]),
);
ok("needsAction flag set only on the group holding it",
  gs[0].needsAction && !gs[1].needsAction && !gs[2].needsAction);

// --- no stage lost or duplicated ------------------------------------------
const total = gs.reduce((n, g) => n + g.stages.length, 0);
ok(`group counts sum to input length (${total} === ${multi.length})`, total === multi.length);
ok("aggregates summed", g1.totalPrepared === 60 && g1.totalSent === 18);

// --- many numbers (the operating range is open-ended) --------------------
// Verified in-browser at 22 numbers on 2026-08-28. This pins the ordering half
// so a refactor can't quietly bury the numbers needing attention behind a
// scroll: the dropdown list scrolls at ~9 rows, so "needs-action groups sort
// first" is the ONLY thing keeping them reachable without scrolling at any count.
const MANY = 25;
const manyStages = Array.from({ length: MANY }, (_, k) =>
  // Attention on three widely-separated numbers, deliberately including the LAST
  // one: if group ordering ever degraded to input order, n=24 would sink to the
  // bottom of a 25-long list and this check catches it.
  mk(
    k,
    k === 24 || k === 11 || k === 3 ? "missed_failed" : "prepared",
    t(6 + (k % 12)),
    "n" + k,
  ),
);
const manyGroups = groupStagesByPhone(manyStages);
ok(MANY + " numbers produce " + MANY + " groups", manyGroups.length === MANY);
const flagged = manyGroups.filter((g) => g.needsAction);
ok(
  "all 3 needs-action groups sort into the first 3 slots (got: " +
    manyGroups.slice(0, 3).map((g) => g.key).join(",") + ")",
  flagged.length === 3 && manyGroups.slice(0, 3).every((g) => g.needsAction),
);
ok(
  "the LAST-indexed number still reaches the top when it needs action",
  manyGroups.slice(0, 3).some((g) => g.provider_phone_id === 24),
);
ok(
  "no stage lost across many groups",
  manyGroups.reduce((n, g) => n + g.stages.length, 0) === MANY,
);

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
