import { formatInTimeZone } from "date-fns-tz";

import {
  decideFormat,
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotifSettings,
} from "@/lib/reporting/telegram-report-format";

// Verifies the Warsaw-time decision logic against the configurable settings
// (migration 0145). ISO weekday: 1=Mon .. 7=Sun.
//
// Default settings: daily at hour 10 (all days), hourly 16:00–23:00 (all
// days, every hour). The old hardcoded behaviour excluded Sunday from hourly
// and included a 00:00–01:00 midnight extension; those were migrated to
// configurable fields and are no longer active by default (Sunday now included
// in hourly; midnight extension not part of the default window).
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

// ── default settings behaviour ───────────────────────────────────────────────
// Daily at Warsaw 10:00, all days. Hourly 16:00–23:00, all days, every hour.
console.log("\n── Default settings ──");
check("Warsaw 10:00 Mon → daily", 10, 1, false, "daily");
check("Warsaw 10:00 Sun → daily", 10, 7, false, "daily");
check("Warsaw 11:00 Wed → skip (not daily hour)", 11, 3, false, null);
check("Warsaw 16:00 Mon → hourly", 16, 1, false, "hourly");
check("Warsaw 23:00 Sat → hourly", 23, 6, false, "hourly");
check("Warsaw 16:00 Sun → hourly (Sunday now active by default)", 16, 7, false, "hourly");
check("Warsaw 00:00 Mon → skip (no midnight extension in default window)", 0, 1, false, null);
check("Warsaw 01:00 Mon → skip", 1, 1, false, null);
check("Warsaw 15:00 Wed → skip (before window)", 15, 3, false, null);
check("Warsaw 02:00 Wed → skip (after window)", 2, 3, false, null);

// test=1 forces a send regardless of day/skip rules.
console.log("\n── test=1 (forced send) ──");
check("test=1 at 15:00 Wed → daily", 15, 3, true, "daily");
check("test=1 at 18:00 Wed → hourly", 18, 3, true, "hourly");
check("test=1 at 00:00 Mon → daily (outside hourly window)", 0, 1, true, "daily");
check("test=1 at 11:00 Wed → daily", 11, 3, true, "daily");

// ── custom settings: midnight-spanning window (16:00–01:00) ─────────────────
const midnightSettings: NotifSettings = {
  ...DEFAULT_NOTIFICATION_SETTINGS,
  hourly_window_from: 16,
  hourly_window_to: 1, // spans midnight
};
console.log("\n── Midnight-spanning window (16:00–01:00) ──");
check("Sun 23:00 → hourly", 23, 7, false, "hourly", midnightSettings);
check("Mon 00:00 → hourly (midnight extension, Mon is active)", 0, 1, false, "hourly", midnightSettings);
check("Mon 01:00 → hourly", 1, 1, false, "hourly", midnightSettings);
check("Mon 02:00 → skip (outside window)", 2, 1, false, null, midnightSettings);

// ── custom settings: Sun excluded from hourly via active_weekdays ────────────
const noSundaySettings: NotifSettings = {
  ...DEFAULT_NOTIFICATION_SETTINGS,
  active_weekdays: [1, 2, 3, 4, 5, 6], // Mon–Sat only
};
console.log("\n── Sun excluded (Mon–Sat only) ──");
check("Sun 16:00 → skip (Sun excluded)", 16, 7, false, null, noSundaySettings);
check("Sun 10:00 → skip (Sun excluded from daily too)", 10, 7, false, null, noSundaySettings);
check("Sat 16:00 → hourly", 16, 6, false, "hourly", noSundaySettings);

// ── custom settings: everything disabled ─────────────────────────────────────
const allOffSettings: NotifSettings = {
  ...DEFAULT_NOTIFICATION_SETTINGS,
  daily_report_enabled: false,
  hourly_report_enabled: false,
};
console.log("\n── All reports disabled ──");
check("10:00 Mon → null (daily off)", 10, 1, false, null, allOffSettings);
check("18:00 Wed → null (hourly off)", 18, 3, false, null, allOffSettings);

// ── custom settings: interval=2 (every 2 hours from window start) ───────────
const interval2: NotifSettings = {
  ...DEFAULT_NOTIFICATION_SETTINGS,
  hourly_interval_hours: 2,
};
console.log("\n── Interval=2 (every 2 h from window start at 16:00) ──");
check("16:00 → fires (offset 0)", 16, 1, false, "hourly", interval2);
check("17:00 → skip (offset 1, not divisible by 2)", 17, 1, false, null, interval2);
check("18:00 → fires (offset 2)", 18, 1, false, "hourly", interval2);
check("19:00 → skip (offset 3)", 19, 1, false, null, interval2);
check("20:00 → fires (offset 4)", 20, 1, false, "hourly", interval2);

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
