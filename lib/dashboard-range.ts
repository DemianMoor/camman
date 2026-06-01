import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import { CAMPAIGN_TIMEZONE } from "./campaign-timezone";

// Dashboard date-range presets. All ranges are computed in the campaign
// timezone (ET) so "Today", "This Week" etc. line up with the operator's
// calendar, and so they match the effective-date bucketing the dashboard
// queries use (COALESCE(scheduled_at, sent_at)).
//
// Weeks start on MONDAY (ISO). "This Week" runs Monday → today; "Last Week"
// is the previous complete Mon–Sun. The comparison ("previous period") for a
// given range is:
//   - week presets  → the same window shifted back 7 days
//   - month preset   → the immediately preceding calendar month
//   - everything else → the equal-length window immediately preceding `from`
//
// Ranges are half-open [from, to): `from` is ET-midnight of the first day,
// `to` is ET-midnight of the day AFTER the last day. This makes previous-
// period math and day bucketing clean and avoids inclusive-boundary bugs.

export const DASHBOARD_PRESETS = [
  "today",
  "last_3_days",
  "last_7_days",
  "last_week",
  "this_week",
  "last_month",
  "custom",
] as const;

export type DashboardPreset = (typeof DASHBOARD_PRESETS)[number];

export const DASHBOARD_PRESET_LABELS: Record<DashboardPreset, string> = {
  today: "Today",
  last_3_days: "Last 3 days",
  last_7_days: "Last 7 days",
  last_week: "Last week",
  this_week: "This week",
  last_month: "Last month",
  custom: "Custom range",
};

// Custom ranges are capped at 3 months.
export const MAX_CUSTOM_RANGE_DAYS = 92;

export type ResolvedDashboardRange = {
  preset: DashboardPreset;
  // Current window (UTC instants, half-open).
  current: { from: Date; to: Date; startYmd: string; endExclYmd: string };
  // Previous comparison window (UTC instants, half-open).
  previous: { from: Date; to: Date; startYmd: string; endExclYmd: string };
  // Human label for the current window, e.g. "May 26 – Jun 1".
  label: string;
};

export type ResolveRangeResult =
  | { ok: true; range: ResolvedDashboardRange }
  | { ok: false; error: string };

// ---- ET calendar helpers (all operate on "YYYY-MM-DD" ET day strings) ----

function ymdInEt(date: Date): string {
  return formatInTimeZone(date, CAMPAIGN_TIMEZONE, "yyyy-MM-dd");
}

// UTC instant of ET midnight for a given ET calendar day.
function etMidnightUtc(ymd: string): Date {
  return fromZonedTime(`${ymd}T00:00:00`, CAMPAIGN_TIMEZONE);
}

// Add n calendar days to an ET day string. Uses UTC-noon arithmetic so DST
// transitions can't shift the result onto the wrong day.
function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  noon.setUTCDate(noon.getUTCDate() + n);
  return ymdInEt(noon);
}

function daysBetween(startYmd: string, endYmd: string): number {
  const [ay, am, ad] = startYmd.split("-").map(Number);
  const [by, bm, bd] = endYmd.split("-").map(Number);
  const a = Date.UTC(ay, am - 1, ad, 12);
  const b = Date.UTC(by, bm - 1, bd, 12);
  return Math.round((b - a) / 86_400_000);
}

// Monday-based weekday index for an ET day: Mon=0 … Sun=6.
function mondayIndex(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0=Sun
  return (dow + 6) % 7;
}

// First ET day of the month containing `ymd` ("YYYY-MM-01").
function firstOfMonth(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

// First ET day of the month `n` months before the month containing `ymd`.
function firstOfMonthOffset(ymd: string, monthsBack: number): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7)); // 1-12
  const totalMonths = y * 12 + (m - 1) - monthsBack;
  const ny = Math.floor(totalMonths / 12);
  const nm = (totalMonths % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`;
}

function isValidYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Round-trip through the noon trick to reject e.g. 2026-02-30.
  return ymdInEt(new Date(Date.UTC(y, m - 1, d, 12))) === s;
}

function buildWindow(startYmd: string, endExclYmd: string) {
  return {
    from: etMidnightUtc(startYmd),
    to: etMidnightUtc(endExclYmd),
    startYmd,
    endExclYmd,
  };
}

// Format a half-open [startYmd, endExclYmd) window as "MMM d – MMM d"
// (inclusive of the last day).
function formatLabel(startYmd: string, endExclYmd: string): string {
  const lastYmd = addDays(endExclYmd, -1);
  const fmt = (ymd: string) =>
    formatInTimeZone(etMidnightUtc(ymd), CAMPAIGN_TIMEZONE, "MMM d");
  return startYmd === lastYmd
    ? fmt(startYmd)
    : `${fmt(startYmd)} – ${fmt(lastYmd)}`;
}

// Resolve a preset (and optional custom from/to ET day strings) into the
// current + previous windows. `now` is injectable for testing; defaults to
// the current instant.
export function resolveDashboardRange(
  preset: DashboardPreset,
  opts: { from?: string | null; to?: string | null; now?: Date } = {},
): ResolveRangeResult {
  const now = opts.now ?? new Date();
  const today = ymdInEt(now);

  let startYmd: string;
  let endExclYmd: string;
  // "week" → shift previous window back 7 days; "month" → previous calendar
  // month; "rolling" → equal-length window ending where current starts.
  let prevMode: "rolling" | "week" | "month" = "rolling";

  switch (preset) {
    case "today":
      startYmd = today;
      endExclYmd = addDays(today, 1);
      break;
    case "last_3_days":
      startYmd = addDays(today, -2);
      endExclYmd = addDays(today, 1);
      break;
    case "last_7_days":
      startYmd = addDays(today, -6);
      endExclYmd = addDays(today, 1);
      break;
    case "this_week": {
      const monday = addDays(today, -mondayIndex(today));
      startYmd = monday;
      endExclYmd = addDays(today, 1); // Monday → today inclusive
      prevMode = "week";
      break;
    }
    case "last_week": {
      const thisMonday = addDays(today, -mondayIndex(today));
      startYmd = addDays(thisMonday, -7);
      endExclYmd = thisMonday; // previous complete Mon–Sun
      prevMode = "week";
      break;
    }
    case "last_month":
      startYmd = firstOfMonthOffset(today, 1);
      endExclYmd = firstOfMonth(today);
      prevMode = "month";
      break;
    case "custom": {
      const from = opts.from ?? "";
      const to = opts.to ?? "";
      if (!isValidYmd(from) || !isValidYmd(to)) {
        return { ok: false, error: "Custom range requires valid from/to dates" };
      }
      if (daysBetween(from, to) < 0) {
        return { ok: false, error: "Custom range: from must be on or before to" };
      }
      if (daysBetween(from, to) + 1 > MAX_CUSTOM_RANGE_DAYS) {
        return {
          ok: false,
          error: `Custom range cannot exceed ${MAX_CUSTOM_RANGE_DAYS} days (3 months)`,
        };
      }
      startYmd = from;
      endExclYmd = addDays(to, 1); // inclusive of `to`
      break;
    }
    default:
      return { ok: false, error: `Unknown preset: ${String(preset)}` };
  }

  // Previous window.
  let prevStartYmd: string;
  let prevEndExclYmd: string;
  if (prevMode === "week") {
    prevStartYmd = addDays(startYmd, -7);
    prevEndExclYmd = addDays(endExclYmd, -7);
  } else if (prevMode === "month") {
    prevStartYmd = firstOfMonthOffset(today, 2);
    prevEndExclYmd = startYmd;
  } else {
    const len = daysBetween(startYmd, endExclYmd);
    prevStartYmd = addDays(startYmd, -len);
    prevEndExclYmd = startYmd;
  }

  return {
    ok: true,
    range: {
      preset,
      current: buildWindow(startYmd, endExclYmd),
      previous: buildWindow(prevStartYmd, prevEndExclYmd),
      label: formatLabel(startYmd, endExclYmd),
    },
  };
}

// Enumerate the ET day strings (oldest first) covered by a half-open window.
export function enumerateDays(startYmd: string, endExclYmd: string): string[] {
  const days: string[] = [];
  let cur = startYmd;
  // Guard against pathological inputs (cap at MAX_CUSTOM + a little slack).
  for (let i = 0; i < MAX_CUSTOM_RANGE_DAYS + 2 && cur !== endExclYmd; i++) {
    days.push(cur);
    cur = addDays(cur, 1);
  }
  return days;
}

// Parse a preset string from a query param, falling back to a default.
export function parsePreset(
  raw: string | null,
  fallback: DashboardPreset = "last_7_days",
): DashboardPreset {
  return (DASHBOARD_PRESETS as readonly string[]).includes(raw ?? "")
    ? (raw as DashboardPreset)
    : fallback;
}
