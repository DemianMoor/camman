// The two halves of a campaign audience preview, and the pure merge that
// turns them back into the response the form reads (Task 2, plan §2a).
//
// ⚠️ NO SERVER IMPORTS. The client merges the parts with this exact function,
// and the parity verifier and the bars call it too, so what the form shows is
// what was verified. Moved here verbatim from lib/audience-snapshot.ts, which
// re-exports it.
import type {
  AudiencePreviewResult,
  LifecycleAudienceBreakdown,
} from "./audience-snapshot";
import { LIFECYCLE_CHIP_STATUSES } from "./validators/campaigns";

export interface AudiencePreviewBase {
  excluded_for_optout: number;
  // Lifecycle campaigns only; absent for a legacy one, as on the full result.
  lifecycle?: {
    opted_out: number;
    suppressed: number;
    // Members neither opted out nor suppressed, by contacts.lifecycle_status.
    status_histogram: Record<string, number>;
  };
}

// What the audience part must supply: everything except the group-level
// numbers, which combinePreviewParts takes from the base. A full
// AudiencePreviewResult also satisfies it; its group-level fields are ignored.
export type AudiencePreviewAudiencePart = Omit<
  AudiencePreviewResult,
  "excluded_for_optout" | "lifecycle"
> & {
  lifecycle?: {
    by_status: Record<string, number>;
    excluded: Omit<
      LifecycleAudienceBreakdown["excluded"],
      "opted_out" | "suppressed" | "status_not_selected"
    >;
  };
};

/**
 * The response the form reads, from the two parts. Pure, and used by both the
 * client and the parity verifier, so what the form shows is what was verified.
 * `chips` are the campaign's lifecycle_statuses; unknown values are ignored
 * exactly as chipStatusArrayLiteral ignores them.
 */
export function combinePreviewParts(
  base: AudiencePreviewBase,
  audience: AudiencePreviewAudiencePart,
  chips: readonly string[] | null | undefined,
): AudiencePreviewResult {
  const { lifecycle: audienceLc, ...rest } = audience;
  if (!!audienceLc !== !!base.lifecycle)
    // One part was computed as lifecycle and the other as legacy: the two
    // answers describe different campaigns. Never merge them.
    throw new Error("preview parts disagree on lifecycle_rules");
  const out: AudiencePreviewResult = {
    ...rest,
    excluded_for_optout: base.excluded_for_optout,
  };
  if (audienceLc && base.lifecycle) {
    const allowed = new Set<string>(LIFECYCLE_CHIP_STATUSES);
    const selected = new Set((chips ?? []).filter((c) => allowed.has(c)));
    const statusNotSelected = Object.entries(base.lifecycle.status_histogram)
      .filter(([status]) => !selected.has(status))
      .reduce((sum, [, n]) => sum + n, 0);
    out.lifecycle = {
      by_status: audienceLc.by_status,
      excluded: {
        ...audienceLc.excluded,
        opted_out: base.lifecycle.opted_out,
        suppressed: base.lifecycle.suppressed,
        status_not_selected: statusNotSelected,
      },
    };
  }
  return out;
}
