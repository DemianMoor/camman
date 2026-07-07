import { NextResponse, type NextRequest } from "next/server";

import { formatInTimeZone } from "date-fns-tz";

import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import { notifyTelegram, sendTelegramHtml } from "@/lib/alerts/telegram";
import { computeReportMetrics, etDayRange } from "@/lib/reporting/report-snapshot";
import {
  dailyMessage,
  decideFormat,
  hourlyMessage,
} from "@/lib/reporting/telegram-report-format";

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

// ── resilient send ──────────────────────────────────────────────────────────
// The report fires once per hour with no natural recovery until the next tick,
// so a single transient Telegram/network blip silently drops an hour's report
// (the failure mode we saw: two consecutive top-of-hour ticks lost, then
// recovered). Retry once with a generous timeout — well within maxDuration=60 —
// before giving up. 8s > the 4s best-effort default because losing a whole hour
// is worse than a slightly longer invocation.
const SEND_TIMEOUT_MS = 8000;
const SEND_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendHtmlWithRetry(message: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    try {
      await sendTelegramHtml(message, SEND_TIMEOUT_MS);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < SEND_ATTEMPTS) await sleep(RETRY_BACKOFF_MS);
    }
  }
  throw lastErr;
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
    await sendHtmlWithRetry(message);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Telegram send failed";
    console.error("[telegram-report] send failed after retries:", err);
    // A silent 500 is invisible outside Vercel logs. Fire a best-effort
    // plain-text alert (never throws, no HTML to misparse) so a dropped report
    // is actually noticed. If the whole Telegram path is down this no-ops too —
    // nothing more we can do — but a transient/HTML-parse failure surfaces here.
    await notifyTelegram(
      `⚠️ CamMan ${format} report failed to send (Warsaw ${warsawHour}:00). ${detail}`,
    );
    return NextResponse.json({ error: detail }, { status: 500 });
  }

  return NextResponse.json({ sent: true, format, test });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
