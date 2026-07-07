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

// ── decision logic (pure, unit-tested) ──────────────────────────────────────
// Given the current Warsaw hour (0..23) and ISO weekday (1=Mon..7=Sun), decide
// which report to send. `test` forces a send (test=1): hourly if the hour is
// inside an hourly window shape, else daily. Returns null when nothing sends.
export function decideFormat(
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
  if (warsawHour === 11) return "daily";
  if (warsawHour >= 16 && warsawHour <= 23 && warsawIsoDow !== 7) return "hourly"; // Sun excluded
  if ((warsawHour === 0 || warsawHour === 1) && warsawIsoDow !== 1) return "hourly"; // Mon 00/01 = Sunday's window, excluded
  return null;
}
