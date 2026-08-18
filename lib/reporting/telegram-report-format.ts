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
// Mirrors the table defaults in migration 0145. The cron falls back to these
// when no notification_settings row exists for the org. Exported so the API
// GET handler can return them without a round-trip.
export const DEFAULT_NOTIFICATION_SETTINGS = {
  daily_report_enabled: true,
  hourly_report_enabled: true,
  stall_alert_enabled: true,
  unjoinable_alert_enabled: true,
  daily_report_hour: 10,
  hourly_window_from: 16,
  hourly_window_to: 23,
  hourly_interval_hours: 1 as 1 | 2 | 3,
  active_weekdays: [1, 2, 3, 4, 5, 6, 7] as number[],
};

export type NotifSettings = typeof DEFAULT_NOTIFICATION_SETTINGS;

// ── decision logic (pure, unit-tested) ──────────────────────────────────────
// Given the current Warsaw hour (0..23) and ISO weekday (1=Mon..7=Sun), decide
// which report to send. `test` forces a send (test=1): hourly if the hour is
// inside the hourly window shape, else daily. Returns null when nothing sends.
// `settings` defaults to DEFAULT_NOTIFICATION_SETTINGS when omitted (backwards
// compatible with existing unit tests).
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

  // Day gate: this weekday must be in the active set.
  const dayActive = active_weekdays.includes(warsawIsoDow);

  // The hourly window wraps midnight when from > to (e.g. 22..02), though the
  // default is same-day (16..23). For simplicity we handle same-day only for
  // now; the original code handled 00/01 as a special continuation of the prior
  // day's window, which we preserve by checking that the window spans midnight.
  const hourlyWindowSpansMidnight = hourly_window_from > hourly_window_to;

  function inHourlyShape(hour: number): boolean {
    if (hourlyWindowSpansMidnight) {
      return hour >= hourly_window_from || hour <= hourly_window_to;
    }
    return hour >= hourly_window_from && hour <= hourly_window_to;
  }

  function hourlyFires(hour: number): boolean {
    if (!inHourlyShape(hour)) return false;
    // Interval: only fire at hours that are at multiples of the interval from
    // the window start (so interval=2 on a 16..23 window fires at 16,18,20,22).
    const offset = hourlyWindowSpansMidnight
      ? (hour - hourly_window_from + 24) % 24
      : hour - hourly_window_from;
    return offset % hourly_interval_hours === 0;
  }

  if (test) {
    if (hourly_report_enabled && inHourlyShape(warsawHour)) return "hourly";
    if (daily_report_enabled) return "daily";
    return null;
  }

  if (daily_report_enabled && warsawHour === daily_report_hour && dayActive) {
    return "daily";
  }
  if (hourly_report_enabled && hourlyFires(warsawHour) && dayActive) {
    return "hourly";
  }
  return null;
}
