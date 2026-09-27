import type { LifecycleExclusionKey } from "@/lib/sends/eligibility";

// Human labels for the lifecycle exclusion reasons, shared by every surface
// that shows them: the Prepare dialog (before the send) and the send panel
// (after it).
//
// ⚠️ It lives in its own module, and the key-type import is TYPE-ONLY, so a
// client component can use it without pulling `lib/sends/eligibility.ts` — and
// through it `lib/sale-attribution` and the database client — into the browser
// bundle. The type is erased at compile time; nothing ships.
//
// ⚠️ `Record<LifecycleExclusionKey, string>` is doing real work: adding a
// fourth layer is a COMPILE ERROR here rather than an unlabelled number
// appearing in the UI. That is the same discipline the counts themselves
// follow — see LIFECYCLE_EXCLUSION_KEYS in lib/sends/eligibility.ts.
export const EXCLUSION_LABELS: Record<LifecycleExclusionKey, string> = {
  suppressed: "suppressed",
  bought_offer: "bought this offer",
  freeze_not_due: "freeze not due",
  offer_limit: "offer limit reached",
  offer_cooldown: "offer cooldown",
};
