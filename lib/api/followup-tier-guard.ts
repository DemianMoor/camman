import { FOLLOWUP_TIERS } from "@/lib/drip/children";
import { TIER_LABEL, type FollowupTier } from "@/lib/drip/followup-timing";

// Server-side guard: a stage may only be armed as a BEHAVIOURAL FOLLOW-UP CHILD
// at a tier that has follow-up machinery (Conversion Events Phase 4).
//
// ⚠️ WHY THIS EXISTS AS A REFUSAL AND NOT AS A NON_UPDATABLE ENTRY. The obvious
// close — adding `drip_followup_minutes` to the PATCH route's `NON_UPDATABLE`
// set — is a SILENT FAILURE: that route drops NON_UPDATABLE keys without an
// error, so the timer <Select> in components/campaigns/drip-followup-children.tsx
// would return 200, toast "Follow-up updated", reload and show the old value.
// Every drip child would be frozen at its default for ever with no error
// anywhere. The hole is closed semantically instead — by the TIER, which is the
// thing that is actually wrong — so the editor keeps working untouched.
//
// ⚠️ WHAT IT PREVENTS. lib/campaign-tier.ts's scale runs 0..4 while
// FOLLOWUP_TIERS stops at 2, and the two halves of the follow-up machinery both
// key off the child's tier: runDripFollowups' detection ladder has no arm above
// 2 (so the child can never be due), and lib/drip/lifecycle.ts's reachability
// predicate WAITS on any unsent child at or above the contact's tier. A tier-3
// child therefore satisfies `3 >= 3` for a registrant, never sends, and hangs
// that journey for ever — holding the contact's only live-journey slot against
// every future journey too. That is the exact failure Phase 4 fixed one file
// over, and arming a tier-3 lane by raw PATCH re-creates it.
//
// ⚠️ A NULL TIER IS NOT A LANE AND IS DELIBERATELY ALLOWED. The drip FIRST-SEND
// stage carries `behavioral_tier = NULL` and `drip_active = true` — that is the
// posture switch for the whole drip stage, not a follow-up child. Refusing a
// NULL tier here would break drip itself. The guard only speaks about rows that
// claim to BE a lane.

export interface FollowupTierRefusal {
  message: string;
  field: string;
  reason: string;
}

/** The machine-readable `details.reason`, shared with the test. */
export const FOLLOWUP_TIER_UNSUPPORTED = "followup_tier_unsupported";

/**
 * Returns null when the patch is allowed.
 *
 * `behavioralTier` is the STORED tier of the stage being patched — the tier is
 * not editable through this route, so the stored value is the whole truth.
 */
export function checkFollowupTierSupported({
  behavioralTier,
  dripFollowupMinutes,
  dripActive,
}: {
  behavioralTier: number | null | undefined;
  dripFollowupMinutes?: number | null;
  dripActive?: boolean | null;
}): FollowupTierRefusal | null {
  // Only a patch that ARMS the stage as a follow-up child is in scope. Clearing
  // a timer (null) or switching a child OFF must always be possible — otherwise
  // a stage armed before this guard existed could never be disarmed.
  const field =
    dripFollowupMinutes != null
      ? "drip_followup_minutes"
      : dripActive === true
        ? "drip_active"
        : null;
  if (field === null) return null;

  if (behavioralTier == null) return null; // not a lane — see the header note
  if ((FOLLOWUP_TIERS as number[]).includes(behavioralTier)) return null;

  // Derived from FOLLOWUP_TIERS, never retyped: a refusal message that restates
  // its own valid set goes stale silently (docs/07-conventions.md).
  const supported = FOLLOWUP_TIERS.map(
    (t) => `${t} (${TIER_LABEL[t as FollowupTier]})`,
  ).join(", ");
  return {
    message:
      `Behavioural follow-ups are only supported on tiers ${supported}. ` +
      `This stage is tier ${behavioralTier}, which has no follow-up timer and ` +
      `would hold its contacts' journeys open for ever.`,
    field,
    reason: FOLLOWUP_TIER_UNSUPPORTED,
  };
}
