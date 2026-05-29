import { customAlphabet } from "nanoid";

// =============== SMS segment calculation ===============
//
// Standard SMS encoding rules:
//   GSM-7 base set: 160 chars per segment when the whole message fits in
//     one segment; 153 chars per segment when it spans multiple (the 7-byte
//     UDH header eats into each segment for concatenation).
//   GSM-7 extension chars: count as 2 (they encode as ESC + char).
//   UCS-2 (any character outside the GSM-7 set): 70 chars per single
//     segment, 67 per segment when multi-segment.
//   Code points above the BMP (most emoji) take 2 UTF-16 code units, so
//     they count as 2 characters under UCS-2 framing.

const GSM7_BASE =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

// Standard GSM 7-bit extension table — each of these counts as 2 characters
// because it's transmitted as ESC + char.
const GSM7_EXT = "{}|^~[]\\€\f";

export type SmsCharset = "GSM-7" | "UCS-2";

export interface SmsSegments {
  charset: SmsCharset;
  characters: number;
  segments: number;
  per_segment_limit: number;
  remaining_in_segment: number;
}

function isInGsm7Base(ch: string): boolean {
  return GSM7_BASE.includes(ch);
}

function isInGsm7Ext(ch: string): boolean {
  return GSM7_EXT.includes(ch);
}

export function calculateSmsSegments(text: string): SmsSegments {
  // First pass: detect charset by scanning each Unicode code point.
  let isUcs2 = false;
  for (const ch of text) {
    if (!isInGsm7Base(ch) && !isInGsm7Ext(ch)) {
      isUcs2 = true;
      break;
    }
  }

  if (isUcs2) {
    // UCS-2 counts UTF-16 code units. text.length in JS is already the
    // code-unit count (surrogate pairs land as 2), which is exactly what
    // the SMS framing layer measures.
    const characters = text.length;
    const segments = characters <= 70 ? 1 : Math.ceil(characters / 67);
    const perSegmentLimit = segments === 1 ? 70 : 67;
    const charsInLast = characters - (segments - 1) * perSegmentLimit;
    return {
      charset: "UCS-2",
      characters,
      segments: characters === 0 ? 1 : segments,
      per_segment_limit: perSegmentLimit,
      remaining_in_segment: Math.max(0, perSegmentLimit - charsInLast),
    };
  }

  // GSM-7: count each base char as 1, each extension char as 2.
  let characters = 0;
  for (const ch of text) {
    characters += isInGsm7Ext(ch) ? 2 : 1;
  }
  const segments = characters <= 160 ? 1 : Math.ceil(characters / 153);
  const perSegmentLimit = segments === 1 ? 160 : 153;
  const charsInLast = characters - (segments - 1) * perSegmentLimit;
  return {
    charset: "GSM-7",
    characters,
    segments: characters === 0 ? 1 : segments,
    per_segment_limit: perSegmentLimit,
    remaining_in_segment: Math.max(0, perSegmentLimit - charsInLast),
  };
}

// =============== Em-dash detection ===============
//
// The em dash (—, U+2014) is a common "AI-written" / non-standard tell in SMS
// copy and is outside the GSM-7 set, so a single one forces the whole message
// into UCS-2 framing (70-char segments instead of 160). We surface a soft,
// non-blocking warning so the author can swap it for a hyphen or rephrase.
export const EM_DASH = "—";

export function containsEmDash(text: string): boolean {
  return text.includes(EM_DASH);
}

// =============== Slug generation ===============
//
// Lowercase alphanumeric, ambiguous-looking characters removed. Used as a
// short-link path component, so visually distinct chars matter. 6-char
// slugs over a 31-char alphabet give ~887M combinations — plenty of room
// for retries on collision. Excluded: l, i, o (look like 1, 0); 0, 1.
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SLUG_LENGTH = 6;
const slugNanoid = customAlphabet(SLUG_ALPHABET, SLUG_LENGTH);

export function generateCreativeSlug(): string {
  return slugNanoid();
}
