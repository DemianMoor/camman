import { etMinutesOfDay, type StageWindow } from "./windows";

// Drip hourly send cap (spec 2026-10-13). PURE — no DB, so the maintenance
// pass, the scheduler and the tests share one definition of each rule.
//
// ⭐ THE HOUR KEY IS THE UTC HOUR. ET offsets are whole hours, so ET clock-hour
// boundaries ARE UTC hour boundaries — and truncating the UTC instant keeps the
// DST fall-back night's two 01:xx ET hours distinct, which a local-time
// truncation would merge into one capped hour.

export const HOUR_MS = 3_600_000;

export function hourStartOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

export function minutesIntoHour(at: Date): number {
  return (at.getTime() - hourStartOf(at).getTime()) / 60_000;
}

/** Half-open [start, end), the same rule as pickStage. */
export function inAnyWindow(at: Date, windows: StageWindow[]): boolean {
  const m = etMinutesOfDay(at);
  return windows.some((w) => m >= w.window_start_min && m < w.window_end_min);
}

export type MissedHourCause = "cap" | "closed" | "blocked";

export const MISSED_HOUR_CLOSE_REASON: Record<MissedHourCause, string> = {
  cap: "missed_hour_cap",
  closed: "missed_hour_closed",
  blocked: "missed_hour_blocked",
};

export interface HourCounts {
  /** First sends in the current hour (follow-ups never count). */
  sentInHour: number;
  freshUnsentInHour: number;
  backlogUnsentInHour: number;
  /** Assigned to an EARLIER hour, still unsent (ON only — OFF closes them). */
  queuedUnsent: number;
}

/**
 * How many waiting leads may be released into the current hour.
 * ON: whatever the hour has left after everything already assigned.
 * OFF (R1): fresh first — and backlog paced evenly over the hour, so a late
 * fresh burst still finds room. ceil(cap × max(m,1)/60) lets the first minute
 * release a little rather than nothing.
 */
export function backlogRoom(i: {
  cap: number; carry: boolean; counts: HourCounts; minutesIntoHour: number;
}): number {
  const { sentInHour, freshUnsentInHour, backlogUnsentInHour, queuedUnsent } = i.counts;
  if (i.carry) {
    return Math.max(0, i.cap - sentInHour - freshUnsentInHour - backlogUnsentInHour - queuedUnsent);
  }
  const room = i.cap - sentInHour - freshUnsentInHour - backlogUnsentInHour;
  const paced = Math.ceil((i.cap * Math.max(i.minutesIntoHour, 1)) / 60) - sentInHour - backlogUnsentInHour;
  return Math.max(0, Math.min(room, paced));
}

export interface FreshUnsent { journeyId: string; routedAt: Date; blocked: boolean }

/**
 * OFF, at the end of hour H. Blocked leads (a gate/mint refusal during H) drop
 * as `blocked`. Of the rest, the backlog took B slots of H, so the NEWEST
 * min(U, B) are demoted to waiting instead of dropped (R1: a fresh lead is never
 * dropped in favour of the backlog); the oldest drop as `cap` if H's first sends
 * reached the cap, else `closed` (window shut / daily cap first).
 */
export function planHourEnd(i: {
  cap: number; sentInHour: number; backlogSentInHour: number; freshUnsent: FreshUnsent[];
}): { demote: string[]; drop: { journeyId: string; cause: MissedHourCause }[] } {
  const blocked = i.freshUnsent.filter((f) => f.blocked);
  const rest = i.freshUnsent
    .filter((f) => !f.blocked)
    .sort((a, b) => a.routedAt.getTime() - b.routedAt.getTime() || a.journeyId.localeCompare(b.journeyId));
  const nDemote = Math.min(rest.length, i.backlogSentInHour);
  const cause: MissedHourCause = i.sentInHour >= i.cap ? "cap" : "closed";
  return {
    demote: rest.slice(rest.length - nDemote).map((f) => f.journeyId),
    drop: [
      ...blocked.map((f) => ({ journeyId: f.journeyId, cause: "blocked" as const })),
      ...rest.slice(0, rest.length - nDemote).map((f) => ({ journeyId: f.journeyId, cause })),
    ],
  };
}

const t = (v: string | Date | null) => (v == null ? 0 : new Date(v).getTime());

/** Send order inside one hourly-capped campaign. ON: queue first, oldest first.
 *  OFF: fresh first, backlog fills (R1). Ties: routed_at, then id. */
export function orderForHour<T extends {
  hour_start: string | Date | null; hour_fresh: boolean | null;
  routed_at: string | Date; journey_id: string;
}>(rows: T[], carry: boolean): T[] {
  return [...rows].sort((a, b) =>
    (carry ? t(a.hour_start) - t(b.hour_start) : Number(a.hour_fresh === false) - Number(b.hour_fresh === false)) ||
    t(a.routed_at) - t(b.routed_at) ||
    a.journey_id.localeCompare(b.journey_id));
}
