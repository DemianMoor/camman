import { nextWindowOpenAtOrAfter, type ProviderSendWindow } from "@/lib/quiet-hours";

// ─── P4: parent-complete gate + bounded slip for lane children ──────────────
//
// A lane child (campaign_stages.parent_stage_id set) must not fire until its
// parent stage has FULLY sent. This PURE function decides what the scheduler
// should do with a DUE child (caller guarantees scheduled_at <= now), given the
// parent's state. It never touches the DB or the clock — everything is a
// parameter — so it is exhaustively unit-testable (mirrors decideScheduledSend).
//
// TWO REGIMES, because we approximate the parent's actual completion time with
// `now` (the detection tick), which is only accurate (≤ one 5-min tick) when the
// child is ACTIVELY WAITING on a still-running parent:
//
//   • Parent already COMPLETE when the child first comes due (the common case:
//     the parent blast finished well before the follow-up lane's slot) → FIRE at
//     the child's original time. The intended parent→child gap is already baked
//     into what the operator scheduled; adding `offset` again would over-delay.
//
//   • Parent still INCOMPLETE when the child comes due (the overrun case P4 exists
//     for) → WAIT; on the tick we detect completion (now ≈ parent-actual) → SLIP
//     the child to `now + offset`, preserving the gap from the parent's real
//     finish. This is the only place `now` is used as the completion anchor, so
//     the ≤5-min imprecision holds.
//
// The total slip is capped at 24h past the original scheduled time; beyond it the
// child is HELD (parked for a human) rather than fired or burned as missed:
//   • parent completes but the offset placement overshoots the cap → HOLD.
//   • parent never completes within 24h of the original time → HOLD.
//
// State markers (approved columns, no new state):
//   slip_original_scheduled_at  non-null ⇒ the child WAITED at least once
//     ("engaged"); also preserves the operator's original time for offset/cap.
//   slip_count > 0              ⇒ the child was already re-dated ("placed"); it
//     is never re-slipped — when its placed time arrives it FIREs.

export const SLIP_CAP_MS = 24 * 60 * 60 * 1000;

export type ChildSlipAction =
  // Parent complete (regime b, or an already-placed child whose time arrived):
  // proceed to the normal window decision + materialization.
  | { kind: "fire" }
  // Parent still incomplete but within the 24h cap: do nothing this tick.
  // `engage` ⇒ persist slip_original_scheduled_at (first wait marks "engaged").
  | { kind: "wait"; engage: boolean; originalScheduledAt: Date }
  // Re-date the child's scheduled_at to `newScheduledAt` (increments slip_count).
  | { kind: "slip"; newScheduledAt: Date; originalScheduledAt: Date }
  // Park the child (24h cap hit): do not fire, do not burn as missed.
  | {
      kind: "hold";
      reason: "slip_cap_exceeded" | "parent_incomplete_24h";
      originalScheduledAt: Date;
    };

export interface ChildSlipInputs {
  now: Date;
  // The child's CURRENT scheduled_at (== original until the one-time re-date).
  childScheduledAt: Date;
  // Stored original scheduled_at; non-null ⇒ the child has WAITED ("engaged").
  slipOriginalScheduledAt: Date | null;
  // Times the child has been re-dated; > 0 ⇒ already placed (never re-slip).
  slipCount: number;
  // The parent stage's scheduled_at (anchor for the offset).
  parentScheduledAt: Date | null;
  // Parent is FULLY sent: sent_at set AND no 'pending'/'sending' stage_sends.
  parentComplete: boolean;
  // The CHILD's provider send window (quiet-hours placement).
  window: ProviderSendWindow;
  capMs?: number;
}

export function decideChildSlip(inp: ChildSlipInputs): ChildSlipAction {
  const capMs = inp.capMs ?? SLIP_CAP_MS;
  const engaged = inp.slipOriginalScheduledAt != null; // waited at least once
  const placed = inp.slipCount > 0; // already re-dated
  // All offset / cap math is measured from the ORIGINAL operator-set time.
  const original = inp.slipOriginalScheduledAt ?? inp.childScheduledAt;

  // Already placed at a future in-window time and now due again: fire (a complete
  // parent never regresses). The defensive !parentComplete branch waits.
  if (placed) {
    return inp.parentComplete
      ? { kind: "fire" }
      : { kind: "wait", engage: false, originalScheduledAt: original };
  }

  if (inp.parentComplete) {
    // Regime b: parent was ready before the child ever had to wait. The gap is
    // already in the operator-set time — fire now (at the original slot).
    if (!engaged) return { kind: "fire" };
    // Regime a: the child waited and the parent just finished (now ≈ parent
    // actual). Re-date to now + the intended parent→child gap, pushed out of
    // quiet hours. offset is clamped ≥ 0 (a child scheduled before its parent).
    const offsetMs = Math.max(
      0,
      original.getTime() - (inp.parentScheduledAt?.getTime() ?? original.getTime()),
    );
    const candidate = new Date(inp.now.getTime() + offsetMs);
    const placedTime = nextWindowOpenAtOrAfter(inp.window, candidate);
    if (placedTime.getTime() > original.getTime() + capMs) {
      return { kind: "hold", reason: "slip_cap_exceeded", originalScheduledAt: original };
    }
    return { kind: "slip", newScheduledAt: placedTime, originalScheduledAt: original };
  }

  // Parent NOT complete. Park it once we've waited past the cap; else wait
  // (marking the child engaged on the first wait).
  if (inp.now.getTime() > original.getTime() + capMs) {
    return { kind: "hold", reason: "parent_incomplete_24h", originalScheduledAt: original };
  }
  return { kind: "wait", engage: !engaged, originalScheduledAt: original };
}
