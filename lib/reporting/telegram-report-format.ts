// Pure formatting + decision helpers for the scheduled Telegram performance
// report. Extracted from the route handler because Next.js route files may
// only export request handlers (GET/POST/…) and a fixed set of config
// exports — exporting these helpers from the route breaks the production
// build's route-type check. Kept here so both the route and the unit tests
// (scripts/test-telegram-report-*.ts) import from one place.

import { escapeHtml } from "@/lib/alerts/telegram";
import type { ReportMetrics } from "@/lib/reporting/report-snapshot";

// ── formatting helpers ──────────────────────────────────────────────────────
const money = (n: number): string =>
  `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
// Sign-aware currency for values that can go negative (net profit): the minus
// sits before the $ (-$50.00, not $-50.00).
const signedMoney = (n: number): string => (n < 0 ? `-${money(-n)}` : money(n));
const int = (n: number): string => n.toLocaleString("en-US");
const roi = (pct: number | null): string =>
  pct == null ? "n/a" : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
const optOutLine = (m: ReportMetrics): string => {
  if (m.delivered <= 0) {
    return `Opt-outs: ${int(m.optOuts)} (n/a — 0 delivered)`;
  }
  const ratio = ((m.optOuts / m.delivered) * 100).toFixed(1);
  return `Opt-outs: ${int(m.optOuts)} (${ratio}% of ${int(m.delivered)} delivered)`;
};

export function dailyMessage(dayLabel: string, m: ReportMetrics): string {
  return [
    `📊 <b>CamMan — ${escapeHtml(dayLabel)}</b> (final, ET)`,
    `Sales: ${int(m.sales)}`,
    `Revenue: ${money(m.revenue)}`,
    `Spend: ${money(m.spend)}`,
    `ROI: ${roi(m.roiPct)}`,
    `Net Profit: ${signedMoney(m.revenue - m.spend)}`,
    optOutLine(m),
  ].join("\n");
}

export function hourlyMessage(
  dayLabel: string,
  m: ReportMetrics,
  yesterdaySpend: number,
): string {
  return [
    `⏱ <b>CamMan — ${escapeHtml(dayLabel)}</b> (so far, ET)`,
    `Sales: ${int(m.sales)}`,
    `Revenue: ${money(m.revenue)}`,
    `Spend: ${money(m.spend)}`,
    `ROI: ${roi(m.roiPct)}`,
    `Net Profit: ${signedMoney(m.revenue - m.spend)}`,
    optOutLine(m),
    `Yesterday spend: ${money(yesterdaySpend)}`,
  ].join("\n");
}

// ── notification settings defaults ──────────────────────────────────────────
// Mirrors the column defaults in migration 0173. The cron falls back to these
// when no notification_settings row exists for the org, so an org without a
// row behaves exactly as it did before the table existed. Exported so the API
// GET handler can return them without a round-trip.
//
// ⭐ These are NOT "sensible defaults" — they are a transcription of the
// hard-coded schedule they replaced, and two of them look wrong until you
// know that: hourly_window_to is 1 because the live window was 16:00–01:59
// (the old `hour === 0 || hour === 1` branch is the tail of the evening
// window, not a separate rule), and active_weekdays omits Sunday because
// Sunday evening never sent. Changing either changes what production does.
export const DEFAULT_NOTIFICATION_SETTINGS = {
  daily_report_enabled: true,
  hourly_report_enabled: true,
  stall_alert_enabled: true,
  unjoinable_alert_enabled: true,
  daily_report_hour: 10,
  hourly_window_from: 16,
  // 1, not 23 — the window wraps midnight. from > to is what marks the wrap.
  hourly_window_to: 1,
  hourly_interval_hours: 1 as 1 | 2 | 3,
  // ISO weekdays (1=Mon..7=Sun). Sunday out, matching the old `isoDow !== 7`.
  active_weekdays: [1, 2, 3, 4, 5, 6] as number[],
};

export type NotifSettings = typeof DEFAULT_NOTIFICATION_SETTINGS;

/**
 * The ISO weekday whose window a given hour belongs to.
 *
 * For a window that wraps midnight (from > to), the hours after midnight are
 * the tail of YESTERDAY's window — Monday 00:30 is part of Sunday's evening,
 * not Monday's. The weekday set is matched against that owning day, which is
 * what makes `active_weekdays` without Sunday reproduce BOTH halves of the old
 * rule: `isoDow !== 7` (no Sunday evening) and `isoDow !== 1` (no Monday
 * 00:00–01:59, because those two hours were Sunday's).
 *
 * Getting this wrong is silent: gate on the wall-clock day instead and the
 * only visible symptom is two extra reports at 00:00 and 01:00 every Monday.
 */
export function hourlyOwningDow(
  warsawHour: number,
  warsawIsoDow: number,
  from: number,
  to: number,
): number {
  const spansMidnight = from > to;
  if (spansMidnight && warsawHour <= to) {
    return warsawIsoDow === 1 ? 7 : warsawIsoDow - 1;
  }
  return warsawIsoDow;
}

// ── decision logic (pure, unit-tested) ──────────────────────────────────────
// Given the current Warsaw hour (0..23) and ISO weekday (1=Mon..7=Sun), decide
// which report to send. `test` forces a send (test=1): hourly if the hour is
// inside the hourly window shape, else daily. Returns null when nothing sends.
// `settings` defaults to DEFAULT_NOTIFICATION_SETTINGS when omitted (backwards
// compatible with existing unit tests).
//
// active_weekdays gates the HOURLY window only. The daily summary has never
// been weekday-gated — it sent at 10:00 seven days a week, including the
// Sundays with no hourly updates — and still isn't; daily_report_enabled is
// the switch for it.
export function decideFormat(
  warsawHour: number,
  warsawIsoDow: number,
  test: boolean,
  settings: NotifSettings = DEFAULT_NOTIFICATION_SETTINGS,
): "daily" | "hourly" | null {
  const {
    daily_report_enabled,
    hourly_report_enabled,
    daily_report_hour,
    hourly_window_from,
    hourly_window_to,
    hourly_interval_hours,
    active_weekdays,
  } = settings;

  const spansMidnight = hourly_window_from > hourly_window_to;

  const inHourlyShape = (hour: number): boolean =>
    spansMidnight
      ? hour >= hourly_window_from || hour <= hourly_window_to
      : hour >= hourly_window_from && hour <= hourly_window_to;

  // Interval counts from the window start, so interval=2 on 16..1 fires at
  // 16, 18, 20, 22, 00 — the wrap is handled by the +24 before the modulo.
  const hourlyFires = (hour: number): boolean => {
    if (!inHourlyShape(hour)) return false;
    const offset = (hour - hourly_window_from + 24) % 24;
    return offset % hourly_interval_hours === 0;
  };

  if (test) {
    if (hourly_report_enabled && inHourlyShape(warsawHour)) return "hourly";
    if (daily_report_enabled) return "daily";
    return null;
  }

  if (daily_report_enabled && warsawHour === daily_report_hour) return "daily";

  const owningDow = hourlyOwningDow(
    warsawHour,
    warsawIsoDow,
    hourly_window_from,
    hourly_window_to,
  );
  if (
    hourly_report_enabled &&
    hourlyFires(warsawHour) &&
    active_weekdays.includes(owningDow)
  ) {
    return "hourly";
  }
  return null;
}
