import { formatInTimeZone } from "date-fns-tz";

import {
  decideFormat,
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotifSettings,
} from "@/lib/reporting/telegram-report-format";

// Verifies the Warsaw-time decision logic behind the Telegram report, now that
// the schedule is configurable per org (migration 0173). ISO weekday: 1=Mon..7=Sun.
//
// ⭐ THE LOAD-BEARING TEST IS THE EQUIVALENCE SWEEP BELOW, not the spot checks.
// Making the schedule configurable is only safe if the SHIPPED DEFAULTS send
// exactly what the hard-coded version sent — otherwise applying the migration
// silently changes what production does, on a cron nobody watches until it
// misfires. So `legacyDecideFormat` is a verbatim transcription of the code
// this replaced, frozen here as an independent anchor, and every one of the
// 24 x 7 hour/weekday pairs (plus the test=1 path) is compared against it.
// Transcribed, NOT imported: importing the new implementation on both sides
// would compare a thing to itself and pass no matter what either does.

let failures = 0;
function check(
  name: string,
  hour: number,
  dow: number,
  test: boolean,
  expected: "daily" | "hourly" | null,
  settings?: NotifSettings,
) {
  const got = decideFormat(hour, dow, test, settings);
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"} ${name}: got ${got}, expected ${expected}`);
}

// ── the pre-0173 hard-coded schedule, transcribed verbatim ───────────────────
// From lib/reporting/telegram-report-format.ts as it stood on main before this
// change. Do not "simplify" it — its value is that it is a copy, not a
// derivation. The two subtle rules: Sunday evening never sent (`!== 7`), and
// Monday 00:00–01:59 never sent (`!== 1`) because those hours are the tail of
// SUNDAY's window.
function legacyDecideFormat(
  warsawHour: number,
  warsawIsoDow: number,
  test: boolean,
): "daily" | "hourly" | null {
  if (test) {
    const inHourlyShape =
      warsawHour === 0 ||
      warsawHour === 1 ||
      (warsawHour >= 16 && warsawHour <= 23);
    return inHourlyShape ? "hourly" : "daily";
  }
  if (warsawHour === 10) return "daily";
  if (warsawHour >= 16 && warsawHour <= 23 && warsawIsoDow !== 7) return "hourly";
  if ((warsawHour === 0 || warsawHour === 1) && warsawIsoDow !== 1) return "hourly";
  return null;
}

console.log("\n── Equivalence sweep: shipped defaults === pre-0173 behaviour ──");
let swept = 0;
let mismatches = 0;
for (const test of [false, true]) {
  for (let dow = 1; dow <= 7; dow++) {
    for (let hour = 0; hour <= 23; hour++) {
      swept++;
      const legacy = legacyDecideFormat(hour, dow, test);
      const now = decideFormat(hour, dow, test);
      if (legacy !== now) {
        mismatches++;
        failures++;
        console.log(
          `✗ FAIL dow=${dow} hour=${String(hour).padStart(2, "0")} test=${test}: legacy=${legacy} now=${now}`,
        );
      }
    }
  }
}
console.log(
  mismatches === 0
    ? `✓ all ${swept} hour/weekday/test combinations match the pre-0173 schedule`
    : `✗ ${mismatches} of ${swept} combinations diverge`,
);

// Control: the sweep can actually go red. If a default is nudged off the
// legacy schedule the comparison MUST notice — otherwise the sweep above is
// decorative and would keep passing through a real regression.
const sundayOn: NotifSettings = {
  ...DEFAULT_NOTIFICATION_SETTINGS,
  active_weekdays: [1, 2, 3, 4, 5, 6, 7],
};
const controlDetected =
  decideFormat(16, 7, false, sundayOn) !== legacyDecideFormat(16, 7, false);
if (!controlDetected) {
  failures++;
  console.log("✗ FAIL control: sweep cannot detect Sunday being switched on");
} else {
  console.log("✓ control: sweep detects Sunday being switched back on");
}

// ── shipped defaults, spelled out ───────────────────────────────────────────
// Daily 10:00 every day; hourly 16:00–01:59 owned by Mon–Sat, every hour.
console.log("\n── Default settings ──");
check("Warsaw 10:00 Mon → daily", 10, 1, false, "daily");
check("Warsaw 10:00 Sun → daily (daily is not weekday-gated)", 10, 7, false, "daily");
check("Warsaw 11:00 Wed → skip (not daily hour)", 11, 3, false, null);
check("Warsaw 16:00 Mon → hourly", 16, 1, false, "hourly");
check("Warsaw 23:00 Sat → hourly", 23, 6, false, "hourly");
check("Warsaw 16:00 Sun → skip (Sunday evening excluded)", 16, 7, false, null);
check("Warsaw 00:00 Sun → hourly (tail of Saturday's window)", 0, 7, false, "hourly");
check("Warsaw 00:00 Mon → skip (tail of Sunday's window)", 0, 1, false, null);
check("Warsaw 01:00 Mon → skip (same)", 1, 1, false, null);
check("Warsaw 01:00 Tue → hourly (tail of Monday's window)", 1, 2, false, "hourly");
check("Warsaw 15:00 Wed → skip (before window)", 15, 3, false, null);
check("Warsaw 02:00 Wed → skip (after window)", 2, 3, false, null);

console.log("\n── test=1 (forced send) ──");
check("test=1 at 15:00 Wed → daily", 15, 3, true, "daily");
check("test=1 at 18:00 Wed → hourly", 18, 3, true, "hourly");
check("test=1 at 00:00 Mon → hourly (inside the window shape)", 0, 1, true, "hourly");
check("test=1 at 11:00 Wed → daily", 11, 3, true, "daily");

// ── configurability: the point of the migration ─────────────────────────────
console.log("\n── Same-day window (16:00–23:00, no midnight tail) ──");
const sameDay: NotifSettings = {
  ...DEFAULT_NOTIFICATION_SETTINGS,
  hourly_window_to: 23,
};
check("Sat 23:00 → hourly", 23, 6, false, "hourly", sameDay);
check("Sun 00:00 → skip (window no longer wraps)", 0, 7, false, null, sameDay);
check("Sun 16:00 → skip (Sunday still out)", 16, 7, false, null, sameDay);

console.log("\n── Sunday switched on ──");
check("Sun 16:00 → hourly", 16, 7, false, "hourly", sundayOn);
check("Mon 00:00 → hourly (Sunday's tail now active)", 0, 1, false, "hourly", sundayOn);

console.log("\n── All reports disabled ──");
const allOff: NotifSettings = {
  ...DEFAULT_NOTIFICATION_SETTINGS,
  daily_report_enabled: false,
  hourly_report_enabled: false,
};
check("10:00 Mon → null (daily off)", 10, 1, false, null, allOff);
check("18:00 Wed → null (hourly off)", 18, 3, false, null, allOff);
check("test=1 18:00 Wed → null (both off)", 18, 3, true, null, allOff);

console.log("\n── Interval=2 (every 2 h from window start at 16:00) ──");
const interval2: NotifSettings = {
  ...DEFAULT_NOTIFICATION_SETTINGS,
  hourly_interval_hours: 2,
};
check("16:00 → fires (offset 0)", 16, 1, false, "hourly", interval2);
check("17:00 → skip (offset 1)", 17, 1, false, null, interval2);
check("18:00 → fires (offset 2)", 18, 1, false, "hourly", interval2);
check("19:00 → skip (offset 3)", 19, 1, false, null, interval2);
check("00:00 Tue → fires (offset 8, wrap handled)", 0, 2, false, "hourly", interval2);
check("01:00 Tue → skip (offset 9)", 1, 2, false, null, interval2);

console.log("\n── Daily hour moved ──");
const daily8: NotifSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, daily_report_hour: 8 };
check("08:00 Wed → daily", 8, 3, false, "daily", daily8);
check("10:00 Wed → skip (no longer the daily hour)", 10, 3, false, null, daily8);

// Sanity: ISO-weekday extraction from date-fns-tz matches our assumption.
// 2026-06-28 is a Sunday.
const sundayIso = Number(
  formatInTimeZone(new Date("2026-06-28T14:00:00Z"), "Europe/Warsaw", "i"),
);
if (sundayIso !== 7) {
  failures++;
  console.log(`✗ FAIL ISO weekday: 2026-06-28 gave ${sundayIso}, expected 7 (Sun)`);
} else {
  console.log("\n✓ ISO weekday: 2026-06-28 → 7 (Sunday)");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
