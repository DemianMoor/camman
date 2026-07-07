import { NextResponse, type NextRequest } from "next/server";

import { formatInTimeZone } from "date-fns-tz";

import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import { notifyTelegram, sendTelegramHtml } from "@/lib/alerts/telegram";
import {
  computeReportMetrics,
  etDayRange,
  spendInRange,
} from "@/lib/reporting/report-snapshot";
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
  // Sequential, and yesterday only needs SPEND (one query) — not a whole second
  // computeReportMetrics. This halves the cold-start DB fan-out: 8 concurrent
  // queries → a peak of 4 (today's metrics), matching the daily path. The old
  // 8-way burst hung the pooler on a cold serverless start during busy ET hours,
  // running past maxDuration with no report — which is why the hourly report
  // silently died while the lighter daily report kept delivering.
  const m = await computeReportMetrics(etDayRange(today));
  const yesterdaySpend = await spendInRange(etDayRange(yesterday));
  return hourlyMessage(dayLabel(today), m, yesterdaySpend);
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

// Overall cap on build + send. Must fire BELOW Vercel's maxDuration=60 kill —
// a maxDuration kill produces no alert and no report (the exact silent failure
// we hit). Capping here turns a hung metrics build (cold-start pooler stall)
// into a caught error that alerts. 50s leaves ~10s of headroom for the alert
// fetch afterward.
const OVERALL_TIMEOUT_MS = 50000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer)) as Promise<T>;
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

  // Build AND send inside ONE try/catch under an overall timeout. The build used
  // to run outside the catch, so a slow/hung metrics build produced no alert and
  // no report — the function just ran into Vercel's maxDuration kill with zero
  // signal (this is what dropped the hourly report while daily kept working).
  try {
    await withTimeout(
      (async () => {
        const message =
          format === "daily" ? await buildDaily(now) : await buildHourly(now);
        await sendHtmlWithRetry(message);
      })(),
      OVERALL_TIMEOUT_MS,
      `${format} report`,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : "report failed";
    console.error("[telegram-report] failed:", err);
    // A silent 500 is invisible outside Vercel logs (which aren't retained).
    // Fire a best-effort plain-text alert (never throws, no HTML to misparse) so
    // a dropped report is actually noticed — covers build hangs/timeouts now too,
    // not just send failures.
    await notifyTelegram(
      `⚠️ CamMan ${format} report failed (Warsaw ${warsawHour}:00). ${detail}`,
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
