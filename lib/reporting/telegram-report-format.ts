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

// ── the per-event split ─────────────────────────────────────────────────────
//
// ⭐ THE REPORT IS SENT WITH parse_mode "HTML" AND A PERMANENT FAILURE IS
// PERMANENT. sendTelegramHtml (lib/alerts/telegram.ts) throws on any non-2xx;
// classify() calls a 400 "permanent"; the cron then returns 500 and does the same
// thing every hour, for ever, because nothing about the input changes. Telegram
// answers 400 both for malformed markup and for text over 4096 characters.
//
// event_types.label is FREE TEXT with no CHECK constraint (db/schema.ts) and no
// UI validation — there is no event-type UI at all — so a label containing "<"
// would kill this report until a human edited a database row. Hence: every
// registry-derived string goes through escapeHtml at the point of
// interpolation, and the ASSEMBLED, POST-ESCAPE message is length-capped.
// Neither is tidiness; both are asserted in scripts/test-telegram-report-format.ts.
export const MAX_EVENT_LINES = 6;
export const MAX_MESSAGE_CHARS = 3500;

/**
 * A label, made safe for ONE line of an HTML-parsed message.
 *
 * Two things, in this order, and the order matters: collapse every whitespace
 * run (including newlines) to a single space, THEN escape. A label is free text,
 * so it can contain a newline — and this medium is line-oriented, so a newline
 * inside a label would silently become an extra "line" of the report, able to
 * read like one of the money lines below it. Collapsing first makes "one line
 * per event type" true rather than nearly true; escaping second is what keeps
 * Telegram parsing it at all.
 *
 * An empty or whitespace-only label falls back to the key. `label` is
 * `text NOT NULL` with no CHECK, so "" is representable, and a line reading
 * ": 0" names nothing.
 */
const eventLabel = (t: { key: string; label: string }): string =>
  escapeHtml(t.label.replace(/\s+/g, " ").trim() || t.key);

const moreLine = (n: number): string =>
  `+${n} more event type${n === 1 ? "" : "s"}`;

/**
 * The event block, split into the part that may be DROPPED and the part that
 * may not. Module-private on purpose — see eventLines() below.
 */
function eventBlock(m: ReportMetrics): {
  typed: string[];
  dropped: number;
  residual: string[];
} {
  const shown = m.eventTypes.slice(0, MAX_EVENT_LINES);
  const typed = shown.map((t) => {
    const e = m.events[t.key] ?? { n: 0, revenue: 0, pending_revenue: 0 };
    const amount =
      e.revenue > 0 || e.pending_revenue > 0 ? ` · ${money(e.revenue)}` : "";
    const held =
      e.pending_revenue > 0 ? ` (${money(e.pending_revenue)} pending)` : "";
    return `${eventLabel(t)}: ${int(e.n)}${amount}${held}`;
  });
  // ⭐ THE RESIDUAL. `sales` is NOT Σ (is_purchase) n — it is that sum plus the
  // manual top-up plus anything the registry could not place — so a breakdown
  // printed without these two lines under-explains the number directly above it.
  // They are NOT in `typed`: they are protected from truncation exactly like the
  // money lines, because a split that survives while its residual is dropped is
  // worse than no split at all.
  const residual: string[] = [];
  if (m.manualTopup > 0) {
    residual.push(`Manual tally: +${int(m.manualTopup)} (not in the lines above)`);
  }
  if (m.unmapped > 0) {
    residual.push(`⚠ ${int(m.unmapped)} unmapped — counted nowhere`);
  }
  return { typed, dropped: m.eventTypes.length - shown.length, residual };
}

/**
 * One line per event type, in registry order, capped — followed by the tail
 * marker and the residual lines.
 *
 * ⭐ ONE ARRAY, AND THAT IS THE STRUCTURE THAT ENFORCES THE PAIRING. There is no
 * exported way to obtain the per-type lines WITHOUT the manual-tally and
 * unmapped lines that explain the gap between them and `Sales`; eventBlock() is
 * module-private for that reason. It is the same rule eventColumnBlock() enforces
 * for the report tables — the residual is not a second list a caller may forget.
 *
 * WHAT GETS DROPPED PAST THE CAP: the lowest-priority types under the registry's
 * own order (retarget signals first, then everything else, then purchases, with
 * display_order as the tie-break — orderEventTypes, lib/reporting/event-columns.ts),
 * and the tail is announced rather than silently missing. The five money lines
 * (Revenue, Spend, ROI, Net Profit, opt-outs), the Sales line, the residual lines
 * and the hourly report's Yesterday-spend line are NEVER dropped — they are the
 * report.
 *
 * A type with a zero count still prints its line: the whole point of a
 * registry-driven report is that a configured event type reads 0 rather than
 * vanishing, and "Registrations: 0" at 22:00 is information. (An ARCHIVED type
 * with nothing in the window is already gone by here — computeReportMetrics
 * applies visibleEventTypesByCount before handing the registry over.)
 */
export function eventLines(m: ReportMetrics): string[] {
  const { typed, dropped, residual } = eventBlock(m);
  return [...typed, ...(dropped > 0 ? [moreLine(dropped)] : []), ...residual];
}

/**
 * Assemble a message that FITS, by dropping event lines — never money.
 *
 * ⭐ THE BUDGET IS COUNTED ON THE ASSEMBLED, POST-ESCAPE STRING, not estimated
 * from the inputs: escaping lengthens a string (one "&" becomes five
 * characters), so a cap counted before escaping is simply the wrong number.
 * Each iteration renders the real candidate and measures it.
 *
 * ⭐ LINES ARE DROPPED WHOLE. Nothing here slices inside a line, so an escaped
 * entity can never be cut in half — `&amp;` sliced to `&am` is a 400, and a 400
 * is permanent. `head` and `tail` are never candidates for dropping, so the
 * money lines survive any registry.
 *
 * At most MAX_EVENT_LINES + 1 renders of a <4KB string; the loop is bounded by
 * `kept.length` and terminates.
 */
function assemble(head: string[], m: ReportMetrics, tail: string[]): string {
  const { typed, dropped, residual } = eventBlock(m);
  const kept = [...typed];
  let missing = dropped;
  const render = () =>
    [
      ...head,
      ...kept,
      ...(missing > 0 ? [moreLine(missing)] : []),
      ...residual,
      ...tail,
    ].join("\n");
  while (render().length > MAX_MESSAGE_CHARS && kept.length > 0) {
    kept.pop();
    missing++;
  }
  return capped(render());
}

/**
 * Last line of defence on length. Telegram's limit is 4096; this cuts at 3500
 * and says it did, because a truncated report that arrives beats a complete one
 * that 400s and takes the next N hours with it.
 *
 * ⭐ IT CUTS ON A LINE BOUNDARY, NOT AT AN ARBITRARY INDEX. A blind
 * `slice(0, N)` can land in the middle of an escaped entity — `&amp;` becomes
 * `&am` — and Telegram may answer 400 to the malformed markup. classify() calls
 * a 400 "permanent", sendTelegramReport throws, and the cron 500s every hour:
 * i.e. a blind slice can cause the exact failure this function exists to
 * prevent. Cutting at the last newline before the limit cannot split an entity,
 * because escapeHtml never emits one containing a newline.
 *
 * If there is no newline in range (a single enormous line), the message is
 * REPLACED rather than sliced — an unsendable report is worse than a useless one.
 *
 * ⭐ IT IS DEFENCE IN DEPTH, NOT THE MECHANISM. assemble() above already fits the
 * message by dropping whole event lines, so with a bounded dayLabel this never
 * fires — and if it ever does, the thing that overflowed was a FIXED line, and
 * losing money lines beats a permanent 400. Exported so its own bars can execute
 * the real function rather than a copy of it.
 */
export function capped(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  const marker = "\n… (truncated)";
  const cut = text.lastIndexOf("\n", MAX_MESSAGE_CHARS - marker.length);
  if (cut <= 0) {
    // Wording note: this string deliberately does NOT contain the token
    // ".label" — bar T22 scans this file for exactly that, to prove no registry
    // label reaches a template without going through eventLabel().
    return `⚠️ CamMan report suppressed: the assembled message is ${text.length} characters with no line break to cut on. Check event_types for an enormous label.`;
  }
  return `${text.slice(0, cut)}${marker}`;
}

/**
 * `extraLines` are appended after the money lines and are INSIDE the cap.
 *
 * ⭐ THAT IS THE WHOLE REASON THE PARAMETER EXISTS. The cron used to append its
 * carrier-triage line to the STRING this function returned, which put it outside
 * every length guarantee made here: the cap would have been enforced against a
 * message that is not the one Telegram receives. Passing it in keeps
 * "the assembled, post-escape message is ≤ MAX_MESSAGE_CHARS" true of what is
 * actually SENT. Callers pass ready-to-send text — today's only caller passes
 * three integers — and lines land in the protected tail, so they are never
 * dropped.
 */
export function dailyMessage(
  dayLabel: string,
  m: ReportMetrics,
  extraLines: string[] = [],
): string {
  return assemble(
    [
      `📊 <b>CamMan — ${escapeHtml(dayLabel)}</b> (final, ET)`,
      `Sales: ${int(m.sales)}`,
    ],
    m,
    [
      `Revenue: ${money(m.revenue)}`,
      `Spend: ${money(m.spend)}`,
      `ROI: ${roi(m.roiPct)}`,
      `Net Profit: ${signedMoney(m.revenue - m.spend)}`,
      optOutLine(m),
      ...extraLines,
    ],
  );
}

export function hourlyMessage(
  dayLabel: string,
  m: ReportMetrics,
  yesterdaySpend: number,
): string {
  return assemble(
    [
      `⏱ <b>CamMan — ${escapeHtml(dayLabel)}</b> (so far, ET)`,
      `Sales: ${int(m.sales)}`,
    ],
    m,
    [
      `Revenue: ${money(m.revenue)}`,
      `Spend: ${money(m.spend)}`,
      `ROI: ${roi(m.roiPct)}`,
      `Net Profit: ${signedMoney(m.revenue - m.spend)}`,
      optOutLine(m),
      `Yesterday spend: ${money(yesterdaySpend)}`,
    ],
  );
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
