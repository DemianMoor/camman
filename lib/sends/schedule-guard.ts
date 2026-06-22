// Guard for "a stage can't be scheduled in the past". Pure + dependency-free so
// it's shared by the stage POST/PATCH routes (server enforcement, the source of
// truth) and the stage form (client UX), and the two can never disagree on what
// "in the past" means.

// <input type="datetime-local"> has minute granularity, so a time the operator
// picks for the CURRENT minute can already be a few seconds in the past by the
// time the request lands. Allow a small slack so "now" isn't rejected, while a
// fully-elapsed minute still is.
export const SCHEDULE_PAST_GRACE_MS = 60_000;

// True when an ISO 8601 scheduled time is in the past beyond the grace window.
// A malformed string returns false — shape validation is the Zod schema's job.
export function isScheduledAtInPast(
  iso: string,
  now: number = Date.now(),
): boolean {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return t < now - SCHEDULE_PAST_GRACE_MS;
}
