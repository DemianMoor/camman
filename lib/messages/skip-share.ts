// P4 (spec R1): the "N% would be skipped" figure the stage form, the Prepare
// dialog and the activation dialog all show for a personalized stage. PURE and
// client-safe. A warning, never a block, above SKIP_WARN_PCT.
import { TAGS, findTags } from "./tags";

export const SKIP_WARN_PCT = 50;

/** Share of the stage's audience the personalization layers skip. */
export function tagSkipShare(i: { willSend: number; missingData: number; segmentLimit: number }): {
  skipped: number;
  pct: number;
} {
  const skipped = i.missingData + i.segmentLimit;
  const total = i.willSend + skipped;
  return { skipped, pct: total === 0 ? 0 : Math.round((100 * skipped) / total) };
}

/** Does this creative / custom text use a CONTACT tag (the only kind that can skip anyone)? */
export function usesContactTag(...texts: (string | null | undefined)[]): boolean {
  return findTags(texts.filter(Boolean).join("\n")).some((k) => TAGS[k].scope === "contact");
}
