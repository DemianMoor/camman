// THE renderer: one recipient's SMS body from a stage's message shape (an org
// format template or owner-only custom text), the creative, the link and the
// resolved opt-out footer. PURE and CLIENT-SAFE — every send path and every
// preview calls this, so what a recipient receives can't diverge from what the
// operator previewed (same discipline as lib/sends/opt-out-footer.ts).
//
// Order: tags are expanded in the creative text (and in custom text) from the
// recipient's NORMALIZED values, then assembleMessage places the blocks. Block
// values are never re-scanned, so a creative containing "{url}" stays literal.

import { MAX_SEGMENTS, countSegments } from "@/lib/sends/segments";
import { T1_TEMPLATE, assembleMessage } from "./format";
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
  const blocks = {
    brand: i.brandName,
    creative_text: expand(i.creativeText ?? "", values),
    url: i.linkUrl ?? "",
    stop_text: i.stopText,
  };
  if (i.shape.kind === "template") return assembleMessage(i.shape.template, blocks);
  // Custom text: its tags go through the same single pass as its blocks.
  const tags: Partial<Record<TagKey, string>> = {};
  for (const k of Object.keys(values) as TagKey[]) if (values[k] !== null) tags[k] = values[k]!;
  return assembleMessage(i.shape.text, blocks, tags);
}

/** Tags this stage's message needs: creative text first, then custom text. */
export function requiredTags(i: { shape: MessageShape; creativeText: string | null | undefined }): TagKey[] {
  const custom = i.shape.kind === "custom" ? i.shape.text : "";
  return findTags(`${i.creativeText ?? ""}\n${custom}`);
}

/**
 * The tags that need CONTACT data ({first_name} {zip} {state}). {brand} comes
 * from the campaign and renders without a recipient (spec A5).
 */
export function requiredContactTags(i: { shape: MessageShape; creativeText: string | null | undefined }): TagKey[] {
  return requiredTags(i).filter((k) => TAGS[k].scope === "contact");
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

/**
 * What a stage's personalization asks of each recipient (P4, spec §C). The
 * eligibility layers turn it into SQL (missing_tag_data / segment_limit) and
 * kickoff renders against it, so a contact is skipped by exactly the rule the
 * render would apply.
 * `firstNameMaxLength` is null when {first_name} is not used (no length limit).
 */
export interface TagRules {
  required: TagKey[];
  firstNameMaxLength: number | null;
}

/** A stage with no contact tag: no layer, no skip — every current stage. */
export const NO_TAG_RULES: TagRules = { required: [], firstNameMaxLength: null };

/** The stage cannot send at all — refused at kickoff, never a per-contact skip. */
export interface TagRulesRefusal {
  refused: "segment_ceiling_exceeded" | "multi_segment_not_allowed" | "missing_brand";
  required: TagKey[];
}

export function isTagRulesRefusal(r: TagRules | TagRulesRefusal): r is TagRulesRefusal {
  return "refused" in r;
}

/**
 * PURE. The tag rules for a stage's rendered shape. Returns NO_TAG_RULES before
 * doing anything else when the message needs no contact data, which is what
 * keeps every tag-less stage byte-identical.
 */
export function stageTagRules(i: Omit<RenderInput, "recipient"> & { allowMultiSegment: boolean }): TagRules | TagRulesRefusal {
  const required = requiredContactTags(i);
  if (required.length === 0) return NO_TAG_RULES;
  if (requiredTags(i).includes("brand") && TAGS.brand.normalize(i.brandName) === null) {
    return { refused: "missing_brand", required };
  }
  const maxSegments = i.allowMultiSegment ? MAX_SEGMENTS : 1;
  const refusal = (segments: number): TagRulesRefusal => ({
    refused: segments > MAX_SEGMENTS ? "segment_ceiling_exceeded" : "multi_segment_not_allowed",
    required,
  });
  if (required.includes("first_name")) {
    const max = firstNameMaxLength(i, maxSegments);
    if (max === null) return refusal(countSegments(renderWorstCase(i, 0)).segments);
    return { required, firstNameMaxLength: max };
  }
  // {zip} and {state} have fixed lengths, so their worst case IS every body.
  const segments = countSegments(renderWorstCase(i)).segments;
  return segments > maxSegments ? refusal(segments) : { required, firstNameMaxLength: null };
}

/**
 * PURE. A DRIP campaign's rules across its first-send stages (P5): any stage may
 * be the one that sends, so a lead must satisfy all of them — `required` is the
 * union, `firstNameMaxLength` the tightest (nulls ignored), and any refusal
 * refuses the campaign. A campaign of tag-less stages is NO_TAG_RULES.
 */
export function campaignTagRules(perStage: (TagRules | TagRulesRefusal)[]): TagRules | TagRulesRefusal {
  const required = [...new Set(perStage.flatMap((r) => r.required))];
  const refusal = perStage.find(isTagRulesRefusal);
  if (refusal) return { refused: refusal.refused, required };
  if (required.length === 0) return NO_TAG_RULES;
  const lengths = perStage
    .map((r) => (isTagRulesRefusal(r) ? null : r.firstNameMaxLength))
    .filter((n): n is number => n != null);
  return { required, firstNameMaxLength: lengths.length ? Math.min(...lengths) : null };
}

export function checkRecipientBody(body: string, maxSegments: number): { ok: true } | { ok: false; reason: "segment_limit" } {
  return countSegments(body).segments <= maxSegments ? { ok: true } : { ok: false, reason: "segment_limit" };
}

/** The shape stored on a stage (0216: exactly one of format / custom text). */
export function shapeFromStage(c: {
  message_format_id: number | null;
  custom_text: string | null;
  /** message_formats.template, joined on message_format_id. */
  format_template: string | null;
}): MessageShape {
  if (c.custom_text != null) return { kind: "custom", text: c.custom_text };
  // A NULL template only happens for a stage read before 0216 was applied; T1
  // is exactly what the 0216 backfill assigns such a stage.
  return { kind: "template", formatId: c.message_format_id, template: c.format_template ?? T1_TEMPLATE };
}

/** What a stage_sends row records about the shape that rendered it. */
export function formatStamp(shape: MessageShape): { messageFormatId: number | null; formatCustom: boolean } {
  return shape.kind === "custom"
    ? { messageFormatId: null, formatCustom: true }
    : { messageFormatId: shape.formatId, formatCustom: false };
}
