// Behavioural follow-up timing (Drip Phase 6, rulings G5 + D4).
//
// PURE — no DB, no clock of its own — so every rule below is exhaustively
// testable and the scheduler and the UI preview cannot disagree about when a
// follow-up is due.
//
// ⚠️ TIMERS RUN FROM DETECTION, NOT FROM THE EVENT. offer_reached_at and
// converted_at carry KEITARO'S event time, and the network's postback lag is
// measured in hours (offer reach p50 146 min, conversion p50 219 min over 30
// days). A timer computed from the event is already expired when we learn of it:
// at p50 a 60-minute Offer follow-up would fire INSTANTLY on the next tick, so
// the operator sets 60 minutes and gets zero. `detectedAt` below is always the
// moment WE learned, which is the only clock a timer can honestly run from.
//
// Tier 1 is the exception and needs no separate column: clicks.clicked_at
// defaults to now() at the /r/ request, so a click's detection IS its event.

/** 0 ignored · 1 clicked · 2 reached_offer. Tier 3 (converted) EXITS, never a lane. */
export type FollowupTier = 0 | 1 | 2;

export const TIER_LABEL: Record<FollowupTier, string> = {
  0: "Ignored",
  1: "Clicked",
  2: "Offer",
};

/** Option lists per the spec. Minutes. */
export const TIER_OPTIONS: Record<FollowupTier, number[]> = {
  0: [60, 180, 360, 480, 720, 1080, 1440], // 1/3/6/8/12/18/24h
  1: [15, 30, 60, 180, 360, 720, 1440], //     15m/30m/1/3/6/12/24h
  2: [15, 30, 60, 180, 360, 720, 1440], //     same list as Clicked
};

export const TIER_DEFAULT: Record<FollowupTier, number> = {
  0: 1440, // 24h
  1: 60, //   1h
  2: 60, //   60m — raised from 30m per G5; see the floor note below
};

// ⚠️ THE IGNORED FLOOR (ruling D4). "Ignored" means "we saw no signal", and a
// signal we have not polled for yet is indistinguishable from absence. The
// offer-reach poller runs every 15 minutes, so for the first cycle after a send
// a silent contact may already have reached the offer and simply not been
// looked at. Firing the Ignored follow-up inside that cycle would send the
// wrong message to someone who is actually engaged.
//
// This floor DELAYS ONLY. It can never cause a send, never shortens a timer, and
// never overrides a longer operator choice — it raises the effective time when
// (and only when) the operator picked something shorter than one poll cycle.
export const OFFER_REACH_POLL_CYCLE_MINUTES = 15;

export interface DueInput {
  tier: FollowupTier;
  /** The child's configured timer, minutes. */
  minutes: number;
  /** When WE learned of the signal. For tier 0 there is no signal — see below. */
  detectedAt: Date | null;
  /** When the parent's first-send actually went out. */
  firstSentAt: Date;
}

export type DueResult =
  | { due: true; at: Date; flooredBy: "none" | "ignored_poll_cycle" }
  | { due: false; reason: "no_detection" };

/**
 * When is this follow-up due?
 *
 * Tier 0 has no detection event by definition — its clock starts at the parent's
 * first send, because "ignored" is measured from the message that was ignored.
 * Tiers 1 and 2 start at detection; without one they are not due at all, which
 * is the fail-toward-not-sending direction.
 */
export function followupDueAt(input: DueInput): DueResult {
  const { tier, minutes, detectedAt, firstSentAt } = input;

  if (tier === 0) {
    const base = firstSentAt.getTime();
    const wanted = base + minutes * 60_000;
    const floor = base + OFFER_REACH_POLL_CYCLE_MINUTES * 60_000;
    // max(): the floor may only ever push later.
    return wanted >= floor
      ? { due: true, at: new Date(wanted), flooredBy: "none" }
      : { due: true, at: new Date(floor), flooredBy: "ignored_poll_cycle" };
  }

  if (!detectedAt) return { due: false, reason: "no_detection" };
  return { due: true, at: new Date(detectedAt.getTime() + minutes * 60_000), flooredBy: "none" };
}

/** Is this option list value legal for the tier? The UI and the API share this. */
export function isValidTimer(tier: FollowupTier, minutes: number): boolean {
  return TIER_OPTIONS[tier].includes(minutes);
}

export function formatMinutes(m: number): string {
  if (m < 60) return `${m}m`;
  const h = m / 60;
  return Number.isInteger(h) ? `${h}h` : `${m}m`;
}
