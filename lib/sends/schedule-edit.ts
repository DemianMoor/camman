// The scheduled-send EDIT lock, extracted as a pure decision so it can be
// exercised in isolation (scripts/test-scheduled-reschedule.ts) — the stage
// PATCH route calls this, it is not a re-implementation.
//
// Two rules, both keyed on whether scheduled_at actually CHANGES:
//   1. LOCK — a tracked (API) stage that has FIRED (sent_at set) freezes its
//      scheduled time. A real change is rejected (409 scheduled_locked_after_send).
//   2. CLEAR-MISSED — rescheduling a stage that was marked missed
//      (schedule_missed_at set) clears that marker so the cron re-arms it.
//
// CRITICAL: the lock keys on sent_at, NOT schedule_missed_at. A MISSED stage
// leaves sent_at NULL, so it is NEVER locked and always stays reschedulable —
// otherwise a wrongly-locked missed stage could never clear its marker (the
// cron filters schedule_missed_at IS NULL) and would be stranded forever.

export interface ScheduleEditState {
  linkMode: string | null;
  sentAt: Date | string | null;
  scheduleMissedAt: Date | string | null;
  currentScheduledAt: Date | string | null;
}

export interface ScheduleEditDecision {
  scheduledChanged: boolean; // did the incoming value differ from what's stored?
  locked: boolean; // tracked + fired + a real change → reject the PATCH
  clearMissed: boolean; // a real change on a missed stage → clear the marker
}

// `incomingScheduledAt`: the PATCH payload's scheduled_at. `undefined` means the
// field was absent from the payload (no change). `null` means "clear it". A
// string is an ISO datetime. Compared by epoch ms so an unchanged value (the
// form always echoes scheduled_at back) does NOT count as a change.
export function decideScheduleEdit(
  state: ScheduleEditState,
  incomingScheduledAt: string | null | undefined,
): ScheduleEditDecision {
  let scheduledChanged = false;
  if (incomingScheduledAt !== undefined) {
    const incoming =
      incomingScheduledAt === null ? null : new Date(incomingScheduledAt).getTime();
    const stored = state.currentScheduledAt
      ? new Date(state.currentScheduledAt).getTime()
      : null;
    scheduledChanged = incoming !== stored;
  }

  const locked =
    state.linkMode === "tracked" && state.sentAt != null && scheduledChanged;
  const clearMissed = scheduledChanged && state.scheduleMissedAt != null;

  return { scheduledChanged, locked, clearMissed };
}
