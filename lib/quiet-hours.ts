import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import { CAMPAIGN_TIMEZONE } from "./campaign-timezone";

// ─── Per-provider auto-send window ──────────────────────────────────────────
//
// The send-scheduled cron may only auto-send a stage inside an allowed window,
// expressed in the project timezone (ET) and stored per provider as
// minute-of-day bounds (0–1439) for weekdays and weekends.
//
// ⚠️ KNOWN v1 LIMITATION — sender-zone, not recipient-zone. The window is
// evaluated in the fixed ET zone of the SENDER, NOT each recipient's local
// time. A nationwide send is only TCPA-quiet-hours-safe if recipients are
// actually Eastern; Pacific recipients could be texted up to ~3h before their
// local window opens. Real per-recipient compliance needs recipient-timezone
// data we don't capture yet. This is a conscious simplification to revisit,
// not an assumption that all recipients are ET.

export const DEFAULT_SEND_WINDOW_START_MIN = 8 * 60; // 08:00 ET
export const DEFAULT_SEND_WINDOW_END_MIN = 21 * 60; // 21:00 ET (9pm)

export interface ProviderSendWindow {
  send_window_weekday_start: number | null;
  send_window_weekday_end: number | null;
  send_window_weekend_start: number | null;
  send_window_weekend_end: number | null;
}

export function minutesToHhmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Resolve the effective [startMin, endMin) window for a day-type. A configured
// pair applies only when BOTH bounds are present and start < end (a wrap-around
// or zero-width range isn't a meaningful "allowed send" window); otherwise the
// default window applies. This is the single fallback rule — keep it the only
// place that decides "configured vs default".
function effectiveWindow(
  cfg: ProviderSendWindow,
  isWeekend: boolean,
): { start: number; end: number } {
  const start = isWeekend
    ? cfg.send_window_weekend_start
    : cfg.send_window_weekday_start;
  const end = isWeekend
    ? cfg.send_window_weekend_end
    : cfg.send_window_weekday_end;
  if (start != null && end != null && start < end) return { start, end };
  return {
    start: DEFAULT_SEND_WINDOW_START_MIN,
    end: DEFAULT_SEND_WINDOW_END_MIN,
  };
}

// ET wall-clock parts of a UTC instant. Uses date-fns-tz string formatting so
// the conversion (and thus DST) is handled by the IANA zone, never a fixed
// offset — the 8am/9pm boundaries stay correct on clock-change days.
function etParts(instant: Date): {
  isWeekend: boolean;
  minuteOfDay: number;
  dateStr: string;
} {
  const isoDow = Number(formatInTimeZone(instant, CAMPAIGN_TIMEZONE, "i")); // 1=Mon … 7=Sun
  const hh = Number(formatInTimeZone(instant, CAMPAIGN_TIMEZONE, "H"));
  const mm = Number(formatInTimeZone(instant, CAMPAIGN_TIMEZONE, "m"));
  const dateStr = formatInTimeZone(instant, CAMPAIGN_TIMEZONE, "yyyy-MM-dd");
  return { isWeekend: isoDow === 6 || isoDow === 7, minuteOfDay: hh * 60 + mm, dateStr };
}

// The UTC open/close instants of the allowed window on `scheduledAt`'s ET day.
function windowInstants(
  cfg: ProviderSendWindow,
  scheduledAt: Date,
): { open: Date; close: Date } {
  const { isWeekend, dateStr } = etParts(scheduledAt);
  const { start, end } = effectiveWindow(cfg, isWeekend);
  const open = fromZonedTime(`${dateStr}T${minutesToHhmm(start)}:00`, CAMPAIGN_TIMEZONE);
  const close = fromZonedTime(`${dateStr}T${minutesToHhmm(end)}:00`, CAMPAIGN_TIMEZONE);
  return { open, close };
}

export type ScheduleDecision = "hold" | "fire" | "missed";

// Decide what the cron should do with a DUE scheduled stage (caller guarantees
// scheduled_at <= now). The window is anchored to scheduled_at's ET day, so a
// send NEVER rolls to a later calendar day: once that day's window closes it is
// 'missed', not deferred to tomorrow.
//   now < open   → 'hold'   (window not open yet today; retry next tick)
//   open ≤ now<close → 'fire'
//   now ≥ close   → 'missed' (covers "scheduled past close" and "scheduled into
//                             quiet hours" — both leave no window left that day)
export function decideScheduledSend(
  cfg: ProviderSendWindow,
  scheduledAt: Date,
  now: Date,
): ScheduleDecision {
  const { open, close } = windowInstants(cfg, scheduledAt);
  if (now >= close) return "missed";
  if (now < open) return "hold";
  return "fire";
}

// True when a scheduled time falls OUTSIDE its ET day's allowed window — used to
// warn (non-blocking) on the stage form that the message won't auto-send then.
// Pure function of the scheduled instant (no `now`).
export function isOutsideSendWindow(
  cfg: ProviderSendWindow,
  scheduledAt: Date,
): boolean {
  const { isWeekend, minuteOfDay } = etParts(scheduledAt);
  const { start, end } = effectiveWindow(cfg, isWeekend);
  return minuteOfDay < start || minuteOfDay >= end;
}
