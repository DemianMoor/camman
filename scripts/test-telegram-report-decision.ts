import { formatInTimeZone } from "date-fns-tz";

import { decideFormat } from "@/lib/reporting/telegram-report-format";

// Verifies the Warsaw-time decision logic against the brief's edge cases.
// ISO weekday: 1=Mon .. 7=Sun.
let failures = 0;
function check(
  name: string,
  hour: number,
  dow: number,
  test: boolean,
  expected: "daily" | "hourly" | null,
) {
  const got = decideFormat(hour, dow, test);
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"} ${name}: got ${got}, expected ${expected}`);
}

// From the brief's Verify §2.
check("Warsaw Sunday 16:00 → skip", 16, 7, false, null);
check("Warsaw Sunday 01:00 → hourly (Saturday's window)", 1, 7, false, "hourly");
check("Warsaw Monday 00:00 → skip", 0, 1, false, null);
check("Warsaw Monday 01:00 → skip", 1, 1, false, null);
check("Warsaw Monday 16:00 → hourly", 16, 1, false, "hourly");
check("Warsaw 10:00 Mon → daily", 10, 1, false, "daily");
check("Warsaw 10:00 Sun → daily", 10, 7, false, "daily");
check("Warsaw 11:00 Wed → skip (no longer daily)", 11, 3, false, null);

// Extra coverage.
check("Warsaw Saturday 23:00 → hourly", 23, 6, false, "hourly");
check("Warsaw Sunday 00:00 → hourly (Saturday's window)", 0, 7, false, "hourly");
check("Warsaw Sunday 23:00 → skip", 23, 7, false, null);
check("Warsaw Wed 15:00 → skip (before window)", 15, 3, false, null);
check("Warsaw Wed 02:00 → skip (after window)", 2, 3, false, null);
check("Warsaw Wed 12:00 → skip (not 10)", 12, 3, false, null);
check("Warsaw Wed 09:00 → skip (before daily)", 9, 3, false, null);

// test=1 forces a send regardless of day/skip rules.
check("test=1 at 15:00 → daily", 15, 3, true, "daily");
check("test=1 at 18:00 → hourly", 18, 3, true, "hourly");
check("test=1 at 00:00 Monday → hourly (forced)", 0, 1, true, "hourly");
check("test=1 at 11:00 → daily", 11, 3, true, "daily");

// Sanity: ISO-weekday extraction from date-fns-tz matches our assumption.
// 2026-06-28 is a Sunday.
const sundayIso = Number(
  formatInTimeZone(new Date("2026-06-28T14:00:00Z"), "Europe/Warsaw", "i"),
);
if (sundayIso !== 7) {
  failures++;
  console.log(`✗ FAIL ISO weekday: 2026-06-28 gave ${sundayIso}, expected 7 (Sun)`);
} else {
  console.log("✓ ISO weekday: 2026-06-28 → 7 (Sunday)");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
