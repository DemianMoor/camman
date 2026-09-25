// The "Excl segments are applied now, not at send" warning (PR 4b Task 6).
//
// A lifecycle campaign's EXCLUDE segments are evaluated when the audience is
// frozen — at activation. If the first stage does not go out for days, the
// exclusion reflects a world that has since moved: a contact who becomes
// suppressed tomorrow was not excluded today, and a contact excluded today may
// have been fine by the time the message goes out.
//
// ⚠️ This is a PURE function on purpose, and it is the ONLY place the decision
// is made. The warning is shown from two different pages whose data arrives by
// two different routes (the detail page has it in client state; the list page
// has to prefetch it). Letting either page decide for itself is how a warning
// ends up correct on one screen and absent on the other — which is worse than
// not having it, because the absence reads as "nothing to worry about".
// scripts/test-excl-timing-warning.ts asserts both call sites produce an
// identical argument object for the same campaign.

// How far out the earliest scheduled stage has to be before the gap is worth
// mentioning. Under a day, "now" and "at send" are the same world.
export const EXCL_TIMING_WARNING_MS = 24 * 60 * 60 * 1000;

export const EXCL_TIMING_WARNING_TEXT =
  "Excl segments are applied now, not at send.";

export interface ExclTimingInput {
  // campaigns.lifecycle_rules. Legacy campaigns never warn.
  lifecycleRules: boolean;
  // campaigns.audience_exclude_segment_ids.
  excludeSegmentIds: number[];
  // The earliest scheduled_at across the campaign's stages, ISO or null.
  // NULL means nothing is scheduled ⇒ there is no gap to compare ⇒ no warning.
  earliestScheduledAt: string | null;
  // Injected rather than read from the clock, so the decision is testable and
  // both call sites are provably given the same inputs.
  now: number;
}

/**
 * Whether to show the Excl-timing warning. A warning, never a block.
 *
 * Returns false when: the campaign is legacy, it has no exclude segments, no
 * stage is scheduled, or the earliest one fires within EXCL_TIMING_WARNING_MS.
 * A scheduled time in the PAST is not a warning either — the gap it describes
 * has already closed.
 */
export function shouldWarnExclTiming(input: ExclTimingInput): boolean {
  if (!input.lifecycleRules) return false;
  if (input.excludeSegmentIds.length === 0) return false;
  if (!input.earliestScheduledAt) return false;
  const at = Date.parse(input.earliestScheduledAt);
  if (Number.isNaN(at)) return false;
  return at - input.now > EXCL_TIMING_WARNING_MS;
}

/**
 * Build the input from a campaign's fields and its stages' scheduled times.
 *
 * Both mount sites call THIS, not shouldWarnExclTiming directly, so neither
 * gets to decide what "earliest scheduled" means. Stages with no scheduled_at
 * are ignored rather than treated as zero.
 */
export function exclTimingInput(campaign: {
  lifecycleRules: boolean;
  excludeSegmentIds: number[] | null | undefined;
  stageScheduledAt: (string | null | undefined)[];
  now: number;
}): ExclTimingInput {
  const times = campaign.stageScheduledAt
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .map((s) => Date.parse(s))
    .filter((n) => !Number.isNaN(n));
  return {
    lifecycleRules: campaign.lifecycleRules,
    excludeSegmentIds: campaign.excludeSegmentIds ?? [],
    earliestScheduledAt:
      times.length > 0 ? new Date(Math.min(...times)).toISOString() : null,
    now: campaign.now,
  };
}

/**
 * What the confirm dialog should do, given the transition and whatever the
 * caller has managed to fetch so far.
 *
 * `undefined` and `null` are NOT the same answer and the difference is the
 * whole point: undefined means the caller is still fetching, so confirm is
 * held; null means the caller knows there is nothing to warn about. Collapsing
 * the two would let a dialog be confirmed a moment before its warning appears,
 * which is the one outcome worse than having no warning at all.
 *
 * Lives here rather than inline in the JSX so it can be asserted directly.
 */
export function exclDialogState(
  isActivate: boolean,
  exclTiming: ExclTimingInput | null | undefined,
): { awaiting: boolean; warn: boolean } {
  if (!isActivate) return { awaiting: false, warn: false };
  if (exclTiming === undefined) return { awaiting: true, warn: false };
  return {
    awaiting: false,
    warn: exclTiming !== null && shouldWarnExclTiming(exclTiming),
  };
}
