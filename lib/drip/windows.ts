import { formatInCampaignTimezone } from "@/lib/campaign-timezone";

// Drip stage daily windows (Drip Phase 5).
//
// A drip stage is a DAILY TIME WINDOW in ET, not a one-shot schedule. Windows
// are stored as minutes past ET midnight — the comparison is arithmetic on a
// local wall-clock with no date attached, and a `time`/timestamp column would
// invite dragging a date and a UTC offset into it (the class of bug that made
// TextHub's received_at read six hours wrong).
//
// ⚠️ WINDOWS MAY NOT OVERLAP **OR TOUCH**. 09:30-14:00 followed by 14:00-18:30
// is an error, not a boundary case: the minute 14:00 belongs to both, so a lead
// arriving exactly then has two candidate stages and the "exactly ONE
// first-send" rule has no answer. The spec wants 13:59 or 14:01. This is a
// MULTI-ROW rule so it cannot be a CHECK constraint — it lives here and is
// enforced on save.

export const MINUTES_IN_DAY = 1440;

export interface StageWindow {
  stage_id?: number;
  window_start_min: number;
  window_end_min: number;
}

export function minutesToLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Minutes past ET midnight for an instant. */
export function etMinutesOfDay(at: Date): number {
  const hhmm = formatInCampaignTimezone(at, "HH:mm");
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export type WindowProblem =
  | { kind: "overlap"; a: StageWindow; b: StageWindow; message: string }
  | { kind: "touch"; a: StageWindow; b: StageWindow; message: string }
  | { kind: "too_many"; count: number; message: string }
  | { kind: "invalid"; w: StageWindow; message: string };

export const MAX_FIRST_SEND_STAGES = 5;

/**
 * Validate a whole campaign's window set. Returns every problem, not the first.
 *
 * Returning all of them is deliberate: an operator fixing five stages should see
 * five messages, not discover a new one on each save.
 */
export function validateWindowSet(windows: StageWindow[]): WindowProblem[] {
  const problems: WindowProblem[] = [];

  if (windows.length > MAX_FIRST_SEND_STAGES) {
    problems.push({
      kind: "too_many",
      count: windows.length,
      message: `A drip campaign may have at most ${MAX_FIRST_SEND_STAGES} first-send stages (got ${windows.length}).`,
    });
  }

  for (const w of windows) {
    if (
      !Number.isInteger(w.window_start_min) || !Number.isInteger(w.window_end_min) ||
      w.window_start_min < 0 || w.window_start_min > MINUTES_IN_DAY - 1 ||
      w.window_end_min < 1 || w.window_end_min > MINUTES_IN_DAY ||
      w.window_end_min <= w.window_start_min
    ) {
      problems.push({
        kind: "invalid",
        w,
        message: `Window ${minutesToLabel(w.window_start_min)}–${minutesToLabel(w.window_end_min)} is not a valid time range.`,
      });
    }
  }

  const sorted = [...windows].sort((a, b) => a.window_start_min - b.window_start_min);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.window_start_min < prev.window_end_min) {
      problems.push({
        kind: "overlap",
        a: prev, b: cur,
        message:
          `Windows overlap: ${minutesToLabel(prev.window_start_min)}–${minutesToLabel(prev.window_end_min)} ` +
          `and ${minutesToLabel(cur.window_start_min)}–${minutesToLabel(cur.window_end_min)}.`,
      });
    } else if (cur.window_start_min === prev.window_end_min) {
      // ⚠️ TOUCHING IS ALSO AN ERROR, per the spec. The shared minute would
      // belong to two stages at once.
      problems.push({
        kind: "touch",
        a: prev, b: cur,
        message:
          `Windows touch at ${minutesToLabel(cur.window_start_min)}: ` +
          `${minutesToLabel(prev.window_start_min)}–${minutesToLabel(prev.window_end_min)} ends exactly where ` +
          `${minutesToLabel(cur.window_start_min)}–${minutesToLabel(cur.window_end_min)} begins. ` +
          `Use ${minutesToLabel(prev.window_end_min - 1)} or ${minutesToLabel(cur.window_start_min + 1)}.`,
      });
    }
  }

  return problems;
}

export interface WindowGap {
  after_min: number;
  before_min: number;
  minutes: number;
  message: string;
}

/**
 * Gaps between windows. WARN ONLY — a gap is legal, and a lead arriving in one
 * simply waits for the next window to open. The editor surfaces it because an
 * unintended gap is invisible otherwise.
 */
export function findGaps(windows: StageWindow[]): WindowGap[] {
  const sorted = [...windows].sort((a, b) => a.window_start_min - b.window_start_min);
  const gaps: WindowGap[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const gap = cur.window_start_min - prev.window_end_min;
    if (gap > 1) {
      gaps.push({
        after_min: prev.window_end_min,
        before_min: cur.window_start_min,
        minutes: gap,
        message:
          `Leads arriving between ${minutesToLabel(prev.window_end_min)} and ` +
          `${minutesToLabel(cur.window_start_min)} wait ${gap} minutes for the next window.`,
      });
    }
  }
  return gaps;
}

export interface StagePick {
  stage_id: number;
  /** null = fires now; otherwise the ET minute it opens. */
  opens_at_min: number | null;
}

/**
 * Which stage sends this lead, given the current ET minute.
 *
 * The stage whose window COVERS now, else the next window to open today, else
 * the first window tomorrow. Returns null only when the campaign has no active
 * stages at all.
 *
 * ⚠️ Half-open [start, end): a lead arriving exactly at `end` belongs to the
 * NEXT window, not this one. That is what makes the non-touching rule coherent —
 * with touching windows banned, every minute maps to at most one stage.
 */
export function pickStage(windows: StageWindow[], nowMin: number): StagePick | null {
  const usable = windows.filter(
    (w) => Number.isInteger(w.window_start_min) && Number.isInteger(w.window_end_min),
  );
  if (usable.length === 0) return null;
  const sorted = [...usable].sort((a, b) => a.window_start_min - b.window_start_min);

  const covering = sorted.find(
    (w) => nowMin >= w.window_start_min && nowMin < w.window_end_min,
  );
  if (covering) return { stage_id: covering.stage_id!, opens_at_min: null };

  const next = sorted.find((w) => w.window_start_min > nowMin);
  if (next) return { stage_id: next.stage_id!, opens_at_min: next.window_start_min };

  // Past every window today — the first one tomorrow.
  return { stage_id: sorted[0].stage_id!, opens_at_min: sorted[0].window_start_min };
}
