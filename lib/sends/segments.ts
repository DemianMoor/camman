// Segment counting for the send path (G8 preflight gate, spec §4). Wraps the
// EXISTING GSM-7/UCS-2 implementation in lib/creative-helpers.ts — that
// function is already live in the creative-form inline counter and the stage
// creative-picker dialog's warning badges, so a third reimplementation here
// would risk the send-path gate silently diverging from what the operator
// sees on screen. This module adds only what the send path needs on top:
// the MAX_SEGMENTS hard ceiling and a narrower return shape.
import { calculateSmsSegments } from "@/lib/creative-helpers";

// G8: hard ceiling — text over this many segments is refused at kickoff
// preflight EVEN WITH a creative's allow_multi_segment override on. Tune
// here only (single source of truth).
export const MAX_SEGMENTS = 4;

export type SmsEncoding = "GSM-7" | "UCS-2";

export interface SegmentCount {
  encoding: SmsEncoding;
  chars: number;
  segments: number;
}

export function countSegments(text: string): SegmentCount {
  const r = calculateSmsSegments(text);
  return { encoding: r.charset, chars: r.characters, segments: r.segments };
}

// The opt-out footer wording CamMan owns for Text Request stages (and the value
// a txr stage's `stop_text` should carry). CamMan renders this INTO the body —
// Text Request does NOT append an opt-out footer on API `/messages` sends
// (proven live 2026-08-12: our API send's TR record carried no footer, while
// the footer seen on earlier messages was either typed in-body or added only by
// the TR *portal* UI). Never rely on the provider to add opt-out language.
export const TXR_OPT_OUT_FOOTER = "Text STOP to opt out";

// Compliance backstop for the kickoff gate: does the effective on-wire body
// contain opt-out language? The reserved keyword carriers require is STOP; a
// word-boundary, case-insensitive match is the guard (a backstop, NOT a content
// filter). "Text STOP to opt out" and the default "Stop to END" both pass; an
// empty/omitted footer fails. Checked against the whole rendered body so opt-out
// language anywhere in the message satisfies it.
export function hasOptOutLanguage(text: string): boolean {
  return /\bstop\b/i.test(text);
}
