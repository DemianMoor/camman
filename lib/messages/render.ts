// THE renderer: one recipient's SMS body from a stage's message shape (an org
// format template or owner-only custom text), the creative, the link and the
// resolved opt-out footer. PURE and CLIENT-SAFE — every send path and every
// preview calls this, so what a recipient receives can't diverge from what the
// operator previewed (same discipline as lib/sends/opt-out-footer.ts).
//
// Order: tags are expanded in the creative text (and in custom text) from the
// recipient's NORMALIZED values, then assembleMessage places the blocks. Block
// values are never re-scanned, so a creative containing "{url}" stays literal.

import { countSegments } from "@/lib/sends/segments";
import { assembleMessage } from "./format";
import { TAGS, findTags, type RecipientData, type TagKey } from "./tags";

export type MessageShape =
  | { kind: "template"; formatId: number | null; template: string }
  | { kind: "custom"; text: string };

export interface RenderInput {
  shape: MessageShape;
  brandName: string;
  creativeText: string | null | undefined;
  linkUrl: string | null | undefined;
  /** The RESOLVED opt-out footer (resolveOptOutFooter), not the stage field. */
  stopText: string;
  /** Raw attribute values; normalized here. */
  recipient: RecipientData;
}

export type RenderResult = { ok: true; body: string } | { ok: false; reason: "missing_tag"; tag: TagKey };

const TAG_TOKEN = /\{(first_name|zip|state|brand)\}/g;

function expand(text: string, values: Record<TagKey, string | null>): string {
  return text.replace(TAG_TOKEN, (_, k: TagKey) => values[k] ?? "");
}

function assemble(i: Omit<RenderInput, "recipient">, values: Record<TagKey, string | null>): string {
  const creative = expand(i.creativeText ?? "", values);
  const template = i.shape.kind === "custom" ? expand(i.shape.text, values) : i.shape.template;
  return assembleMessage(template, {
    brand: i.brandName,
    creative_text: creative,
    url: i.linkUrl ?? "",
    stop_text: i.stopText,
  });
}

/** Tags this stage's message needs: creative text first, then custom text. */
export function requiredTags(i: { shape: MessageShape; creativeText: string | null | undefined }): TagKey[] {
  const custom = i.shape.kind === "custom" ? i.shape.text : "";
  return findTags(`${i.creativeText ?? ""}\n${custom}`);
}

export function renderMessage(i: RenderInput): RenderResult {
  if (!i.creativeText) return { ok: true, body: "" };
  const values: Record<TagKey, string | null> = {
    first_name: TAGS.first_name.normalize(i.recipient.first_name),
    zip: TAGS.zip.normalize(i.recipient.zip),
    state: TAGS.state.normalize(i.recipient.state),
    brand: TAGS.brand.normalize(i.brandName),
  };
  const missing = requiredTags(i).find((k) => values[k] === null);
  if (missing) return { ok: false, reason: "missing_tag", tag: missing };
  return { ok: true, body: assemble(i, values) };
}

/**
 * Body with every contact tag at its worst case (first_name at
 * `firstNameLength`, default its max). {brand} uses the real brand when there is
 * one (fixed per stage) and its worst case otherwise (creative editor).
 */
export function renderWorstCase(i: Omit<RenderInput, "recipient">, firstNameLength = TAGS.first_name.maxLength): string {
  return assemble(i, {
    first_name: "X".repeat(firstNameLength),
    zip: TAGS.zip.worstCase,
    state: TAGS.state.worstCase,
    brand: TAGS.brand.normalize(i.brandName) ?? TAGS.brand.worstCase,
  });
}

/**
 * Largest first-name length L (0..15) whose worst-case body fits in
 * `maxSegments`; null when even L = 0 does not fit (stage-level refusal).
 * Exact because a cleaned name is GSM-7 base characters only: each character
 * adds exactly 1 and the charset never flips (spec A6).
 */
export function firstNameMaxLength(i: Omit<RenderInput, "recipient">, maxSegments: number): number | null {
  for (let len = TAGS.first_name.maxLength; len >= 0; len--) {
    if (countSegments(renderWorstCase(i, len)).segments <= maxSegments) return len;
  }
  return null;
}

export function checkRecipientBody(body: string, maxSegments: number): { ok: true } | { ok: false; reason: "segment_limit" } {
  return countSegments(body).segments <= maxSegments ? { ok: true } : { ok: false, reason: "segment_limit" };
}
