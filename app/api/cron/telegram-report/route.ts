import { NextResponse, type NextRequest } from "next/server";

import { formatInTimeZone } from "date-fns-tz";

import { db } from "@/db/client";
import { campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import {
  notifyTelegram,
  sendTelegramReport,
  type TelegramReportOutcome,
} from "@/lib/alerts/telegram";
import { carrierTriageSummary } from "@/lib/carrier/queue-stats";
import { findStalledStages, formatStallAlert } from "@/lib/sends/stall-detector";
import {
  findUnjoinableOptOutAttributions,
  formatUnjoinableAlert,
  shouldAlertUnjoinable,
} from "@/lib/sends/unjoinable-attributions";
import {
  computeReportMetrics,
  etDayRange,
  spendInRange,
} from "@/lib/reporting/report-snapshot";
import {
  dailyMessage,
  decideFormat,
  hourlyMessage,
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotifSettings,
} from "@/lib/reporting/telegram-report-format";
import { sql } from "drizzle-orm";

// Scheduled Telegram performance report. ONE external trigger fires this every
// hour on the hour (UTC); the handler decides internally what to do based on the
// CURRENT Warsaw time. Never hardcode UTC hours — the Warsaw/ET offsets shift on
// DST weeks, so every wall-clock decision goes through Intl-backed
// formatInTimeZone (date-fns-tz), never offset arithmetic.
//
// Schedule is controlled by notification_settings (migration 0173). The
// defaults reproduce the schedule that used to be hard-coded here, so this
// list is both "what the defaults do" and "what this cron did before 0173":
//   • Warsaw hour == 10            → daily report for the PREVIOUS ET day (final).
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

// ── settings loader ─────────────────────────────────────────────────────────
// Best-effort: a DB error or missing row just falls back to defaults. The cron
// is single-org in practice; LIMIT 1 picks up the only org's settings.
async function loadNotifSettings(): Promise<NotifSettings> {
  try {
    const rows = (await db.execute(sql`
      SELECT
        daily_report_enabled, hourly_report_enabled,
        stall_alert_enabled, unjoinable_alert_enabled,
        daily_report_hour, hourly_window_from, hourly_window_to,
        hourly_interval_hours, active_weekdays
      FROM notification_settings
      LIMIT 1
    `)) as unknown as Partial<NotifSettings>[];
    const r = rows[0];
    if (!r) return DEFAULT_NOTIFICATION_SETTINGS;
    return {
      daily_report_enabled: r.daily_report_enabled ?? DEFAULT_NOTIFICATION_SETTINGS.daily_report_enabled,
      hourly_report_enabled: r.hourly_report_enabled ?? DEFAULT_NOTIFICATION_SETTINGS.hourly_report_enabled,
      stall_alert_enabled: r.stall_alert_enabled ?? DEFAULT_NOTIFICATION_SETTINGS.stall_alert_enabled,
      unjoinable_alert_enabled: r.unjoinable_alert_enabled ?? DEFAULT_NOTIFICATION_SETTINGS.unjoinable_alert_enabled,
      daily_report_hour: r.daily_report_hour ?? DEFAULT_NOTIFICATION_SETTINGS.daily_report_hour,
      hourly_window_from: r.hourly_window_from ?? DEFAULT_NOTIFICATION_SETTINGS.hourly_window_from,
      hourly_window_to: r.hourly_window_to ?? DEFAULT_NOTIFICATION_SETTINGS.hourly_window_to,
      hourly_interval_hours: r.hourly_interval_hours ?? DEFAULT_NOTIFICATION_SETTINGS.hourly_interval_hours,
      active_weekdays: r.active_weekdays ?? DEFAULT_NOTIFICATION_SETTINGS.active_weekdays,
    };
  } catch (err) {
    console.error("[telegram-report] failed to load notification settings, using defaults:", err);
    return DEFAULT_NOTIFICATION_SETTINGS;
  }
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
  let msg = dailyMessage(dayLabel(yesterday), m);
  // Fold in a one-line carrier-triage summary (brief §9). Sequential + one small
  // query — the daily path is the robust one, so this doesn't touch the hourly
  // cold-start fan-out. Only shown once the queue has any rows.
  const t = await carrierTriageSummary();
  if (t.resolved + t.needsHuman + t.pending > 0) {
    msg += `\nCarrier triage: ${t.resolved} auto-mapped · ${t.needsHuman} need review · ${t.pending} pending`;
  }
  return msg;
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

// ── resilient send ───────────────────────────────────────────────────────────────────────────
// Retry policy + per-attempt logging live in sendTelegramReport
// (lib/alerts/telegram.ts). It retries ONLY when Telegram answered and proved
// non-delivery; a send whose outcome is unknown (timeout, socket error) is left
// alone rather than re-POSTed, because sendMessage is not idempotent.

// Cap on the metrics BUILD only. Must fire BELOW Vercel's maxDuration=60 kill —
// a maxDuration kill produces no alert and no report (the exact silent failure
// we hit). Capping here turns a hung metrics build (cold-start pooler stall)
// into a caught error that alerts, and a hang that never reached the send is a
// proven "no report", so alerting is correct.
//
// It deliberately does NOT wrap the send. A guard firing while the POST is in
// flight would report a failure for a message Telegram may already have
// delivered — the same false alarm the send policy exists to prevent. The send
// governs its own budget (sendTelegramReport: hard per-attempt abort + capped
// total), so the two guards never overlap. Worst case 30s build + 25s send + 4s
// alert = 59s, inside maxDuration.
const BUILD_TIMEOUT_MS = 30000;

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

// Minutes without a send (while in-window, provider not paused) before a stage
// with pending rows is flagged stalled. With the concurrent + time-boxed drain a
// healthy stage always shows recent sends; 30m of silence is a genuine stall.
const STALL_THRESHOLD_MINUTES = 30;

// Best-effort backlog-stall check. Never throws (own try/catch) so it can't break
// the report. No-ops when global sending is off or the type is disabled.
async function checkStalledQueue(now: Date, enabled: boolean): Promise<void> {
  if (!enabled) return;
  if (process.env.SEND_ENABLED !== "true") return;
  try {
    const stalled = await findStalledStages(db, {
      now,
      thresholdMinutes: STALL_THRESHOLD_MINUTES,
    });
    if (stalled.length > 0) {
      await notifyTelegram(formatStallAlert(stalled, now, STALL_THRESHOLD_MINUTES));
    }
  } catch (err) {
    console.error("[telegram-report] stall check failed:", err);
  }
}

// Window for the unjoinable-attribution watch. A day of STOPs is a big enough
// sample to be meaningful and small enough that a NEW breakage shows up fast.
const UNJOINABLE_WINDOW_HOURS = 24;

// Best-effort blind-spot watch for the opt-out-rate breaker's numerator: STOPs
// whose stage_send_id is NULL can't be aligned to a send and are dropped from
// the rate, so a rising share silently blinds the breaker. Never throws (own
// try/catch) so it can't break the report. One cheap aggregate per hour.
async function checkUnjoinableAttributions(enabled: boolean): Promise<void> {
  if (!enabled) return;
  try {
    const stats = await findUnjoinableOptOutAttributions(db, {
      windowHours: UNJOINABLE_WINDOW_HOURS,
    });
    if (shouldAlertUnjoinable(stats)) {
      await notifyTelegram(formatUnjoinableAlert(stats));
    }
  } catch (err) {
    console.error("[telegram-report] unjoinable-attribution check failed:", err);
  }
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

  // Load notification preferences (best-effort; falls back to defaults).
  const notifSettings = await loadNotifSettings();

  // Phase 3 — backlog-stall safety net. Runs EVERY hourly tick (independent of the
  // report window below), so a queue that silently stops draining is caught within
  // ~an hour regardless of the specific cause. Best-effort: never break the report.
  // Skipped when global sending is off (env SEND_ENABLED) or type is disabled.
  await checkStalledQueue(now, notifSettings.stall_alert_enabled);
  // Same cadence, same best-effort contract: watch the opt-out-rate breaker's
  // numerator for attributions it can no longer align to a send.
  await checkUnjoinableAttributions(notifSettings.unjoinable_alert_enabled);

  const format = decideFormat(warsawHour, warsawIsoDow, test, notifSettings);

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

  // Build AND send share ONE try/catch: each throws only on a PROVEN failure, so
  // both deserve the same loud alert. The build used to run outside the catch,
  // so a slow/hung metrics build produced no alert and no report — the function
  // just ran into Vercel's maxDuration kill with zero signal (this is what
  // dropped the hourly report while daily kept working). The timeout, though,
  // wraps the build ALONE — see BUILD_TIMEOUT_MS.
  let outcome: TelegramReportOutcome;
  try {
    const message = await withTimeout(
      format === "daily" ? buildDaily(now) : buildHourly(now),
      BUILD_TIMEOUT_MS,
      `${format} report build`,
    );
    outcome = await sendTelegramReport(message);
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

  // Telegram never answered. It very likely DID deliver (that is the common
  // shape of a slow response), so this is not a failure and must not read like
  // one — an hour where the report actually arrived used to be alerted as
  // "failed" because the retry loop timed out twice. Say plainly that the
  // outcome is unknown and that we did not re-send, and return 200 so the
  // scheduler doesn't count a delivered report as a failed run.
  if (outcome.status === "unknown") {
    console.warn(
      `[telegram-report] ${format} send outcome unknown after ${outcome.ms}ms:`,
      outcome.detail,
    );
    await notifyTelegram(
      `ℹ️ CamMan ${format} report (Warsaw ${warsawHour}:00): Telegram did not respond within ${outcome.ms}ms, so delivery is UNKNOWN — the report above may already have arrived. Not re-sent (a retry would post it twice). ${outcome.detail}`,
    );
    return NextResponse.json({
      sent: "unknown",
      format,
      test,
      detail: outcome.detail,
    });
  }

  return NextResponse.json({ sent: true, format, test, attempts: outcome.attempts });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
