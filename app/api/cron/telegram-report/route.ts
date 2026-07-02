import { NextResponse, type NextRequest } from "next/server";

import { formatInTimeZone } from "date-fns-tz";

import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import { escapeHtml, sendTelegramHtml } from "@/lib/alerts/telegram";
import {
  computeReportMetrics,
  etDayRange,
  type ReportMetrics,
} from "@/lib/reporting/report-snapshot";

// Scheduled Telegram performance report. ONE external trigger fires this every
// hour on the hour (UTC); the handler decides internally what to do based on the
// CURRENT Warsaw time. Never hardcode UTC hours — the Warsaw/ET offsets shift on
// DST weeks, so every wall-clock decision goes through Intl-backed
// formatInTimeZone (date-fns-tz), never offset arithmetic.
//
//   • Warsaw hour == 11            → daily report for the PREVIOUS ET day (final).
//   • Warsaw hour 16..23, !Sunday  → hourly update (today-so-far, ET).
//   • Warsaw hour 0..1,  !Monday   → hourly update (belongs to the previous
//                                    day's window; Mon 00/01 is Sunday's, excluded).
//   • otherwise                    → 200 { skipped: true }.
//
// Auth: Authorization: Bearer ${CRON_SECRET} (or x-cron-secret). ?test=1 forces
// an immediate send regardless of time (still secret-protected) — hourly format
// if the current Warsaw hour is inside an hourly window shape, else daily.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const WARSAW = "Europe/Warsaw";

// ── formatting helpers ──────────────────────────────────────────────────────
const money = (n: number): string =>
  `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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
    optOutLine(m),
    `Yesterday spend: ${money(yesterdaySpend)}`,
  ].join("\n");
}

// ── ET day bounds ───────────────────────────────────────────────────────────
function etDays(now: Date) {
  const today = campaignDayBoundsUtc(now);
  // 1s before today's ET midnight lands in yesterday's ET day (DST-safe).
  const yesterday = campaignDayBoundsUtc(new Date(today.start.getTime() - 1000));
  return { today, yesterday };
}

// "Tue 30 Jun" rendered in ET from an ET-midnight instant.
function dayLabel(bounds: { start: Date }): string {
  return formatInTimeZone(bounds.start, "America/New_York", "EEE d MMM");
}

// ── report builders ─────────────────────────────────────────────────────────
async function buildDaily(now: Date): Promise<string> {
  const { yesterday } = etDays(now);
  const m = await computeReportMetrics(etDayRange(yesterday));
  return dailyMessage(dayLabel(yesterday), m);
}

async function buildHourly(now: Date): Promise<string> {
  const { today, yesterday } = etDays(now);
  const [m, yMetrics] = await Promise.all([
    computeReportMetrics(etDayRange(today)),
    computeReportMetrics(etDayRange(yesterday)),
  ]);
  return hourlyMessage(dayLabel(today), m, yMetrics.spend);
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
      warsawHour === 0 || warsawHour === 1 || (warsawHour >= 16 && warsawHour <= 23);
    return inHourlyShape ? "hourly" : "daily";
  }
  if (warsawHour === 11) return "daily";
  if (warsawHour >= 16 && warsawHour <= 23 && warsawIsoDow !== 7) return "hourly"; // Sun excluded
  if ((warsawHour === 0 || warsawHour === 1) && warsawIsoDow !== 1) return "hourly"; // Mon 00/01 = Sunday's window, excluded
  return null;
}

// ── handler ─────────────────────────────────────────────────────────────────
async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const warsawHour = Number(formatInTimeZone(now, WARSAW, "H"));
  const warsawIsoDow = Number(formatInTimeZone(now, WARSAW, "i")); // 1=Mon..7=Sun
  const test = req.nextUrl.searchParams.get("test") === "1";

  const format = decideFormat(warsawHour, warsawIsoDow, test);

  if (!format) {
    return NextResponse.json({ skipped: true, warsawHour, warsawIsoDow });
  }

  // Fail fast on missing Telegram config BEFORE building/sending — clear 500,
  // no partial send. (sendTelegramHtml also guards, but we check up front.)
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    return NextResponse.json(
      {
        error:
          "Missing Telegram config: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required",
      },
      { status: 500 },
    );
  }

  const message =
    format === "daily" ? await buildDaily(now) : await buildHourly(now);

  try {
    await sendTelegramHtml(message);
  } catch (err) {
    console.error("[telegram-report] send failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Telegram send failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({ sent: true, format, test });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
