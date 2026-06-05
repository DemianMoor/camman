// Pure-logic checks for lib/quiet-hours.ts — no DB, no network.
// Run: npx tsx scripts/test-quiet-hours.ts
import { fromZonedTime } from "date-fns-tz";

import {
  decideScheduledSend,
  isOutsideSendWindow,
  hhmmToMinutes,
  minutesToHhmm,
  type ProviderSendWindow,
} from "@/lib/quiet-hours";

const ET = "America/New_York";
const et = (s: string) => fromZonedTime(s, ET); // ET wall-clock string -> UTC instant

const DEFAULTS: ProviderSendWindow = {
  send_window_weekday_start: null,
  send_window_weekday_end: null,
  send_window_weekend_start: null,
  send_window_weekend_end: null,
};

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  got=${got} want=${want}`}`);
}

// ── minutes <-> HH:mm round-trip
check("minutesToHhmm(480)", minutesToHhmm(480), "08:00");
check("minutesToHhmm(1260)", minutesToHhmm(1260), "21:00");
check("hhmmToMinutes('08:00')", hhmmToMinutes("08:00"), 480);
check("hhmmToMinutes('21:30')", hhmmToMinutes("21:30"), 1290);

// ── decideScheduledSend, default window 08:00–21:00 ET (Thu 2025-07-10, EDT)
check(
  "fire: scheduled 14:00, now 14:30",
  decideScheduledSend(DEFAULTS, et("2025-07-10T14:00:00"), et("2025-07-10T14:30:00")),
  "fire",
);
check(
  "hold: scheduled 06:00, now 06:30 (before 08:00 open)",
  decideScheduledSend(DEFAULTS, et("2025-07-10T06:00:00"), et("2025-07-10T06:30:00")),
  "hold",
);
check(
  "missed: scheduled 23:00 (into quiet hours), now 23:00",
  decideScheduledSend(DEFAULTS, et("2025-07-10T23:00:00"), et("2025-07-10T23:00:00")),
  "missed",
);
check(
  "missed: scheduled Thu 14:00 but now Fri 13:00 (day's window closed — never rolls)",
  decideScheduledSend(DEFAULTS, et("2025-07-10T14:00:00"), et("2025-07-11T13:00:00")),
  "missed",
);
check(
  "fire: enabled-late — scheduled 14:00, now 20:00 same day (still in window)",
  decideScheduledSend(DEFAULTS, et("2025-07-10T14:00:00"), et("2025-07-10T20:00:00")),
  "fire",
);

// ── isOutsideSendWindow (default window), incl. DST-correct boundaries
check("in-window: 20:00 EDT", isOutsideSendWindow(DEFAULTS, et("2025-07-10T20:00:00")), false);
check("boundary: 21:00 is outside (>= end)", isOutsideSendWindow(DEFAULTS, et("2025-07-10T21:00:00")), true);
check("in-window: 20:00 EST (winter)", isOutsideSendWindow(DEFAULTS, et("2025-01-15T20:00:00")), false);
check("outside: 22:00 EST (winter)", isOutsideSendWindow(DEFAULTS, et("2025-01-15T22:00:00")), true);
// DST spring-forward day (2025-03-09): 20:00 ET still inside, 07:00 ET still before open
check("DST day in-window: 20:00", isOutsideSendWindow(DEFAULTS, et("2025-03-09T20:00:00")), false);
check("DST day before open: 07:00", isOutsideSendWindow(DEFAULTS, et("2025-03-09T07:00:00")), true);

// ── configured weekday window 09:00–17:00, weekend left default
const CFG: ProviderSendWindow = {
  send_window_weekday_start: hhmmToMinutes("09:00"),
  send_window_weekday_end: hhmmToMinutes("17:00"),
  send_window_weekend_start: null,
  send_window_weekend_end: null,
};
check("weekday cfg in-window: Thu 16:00", isOutsideSendWindow(CFG, et("2025-07-10T16:00:00")), false);
check("weekday cfg outside: Thu 17:30", isOutsideSendWindow(CFG, et("2025-07-10T17:30:00")), true);
// Sat 2025-07-12 uses the default window (weekend not configured)
check("weekend falls back to default: Sat 19:00 in-window", isOutsideSendWindow(CFG, et("2025-07-12T19:00:00")), false);

// ── partial config (only one bound) falls back to default
const PARTIAL: ProviderSendWindow = {
  send_window_weekday_start: hhmmToMinutes("09:00"),
  send_window_weekday_end: null,
  send_window_weekend_start: null,
  send_window_weekend_end: null,
};
check("partial cfg -> default: Thu 08:30 in default window", isOutsideSendWindow(PARTIAL, et("2025-07-10T08:30:00")), false);

console.log(failed === 0 ? "\nAll quiet-hours checks passed." : `\nFAILED: ${failed} check(s).`);
if (failed > 0) process.exit(1);
