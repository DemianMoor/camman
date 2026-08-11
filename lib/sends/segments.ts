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

// Text Request AUTO-APPENDS this opt-out footer to every outbound message body
// (confirmed live in Phase 0). We do NOT send it — TR adds it server-side — so
// the on-wire text (and its segment count) is longer than the rendered text.
export const TXR_APPENDED_FOOTER = "\nText STOP to opt out";

// The text as the provider will actually transmit it. Only txr appends a
// footer today; every other provider returns the text unchanged. Used by the G8
// kickoff gate so a message that fits in N segments raw but tips to N+1 with
// TR's footer is caught BEFORE send, and by the drain's segment accounting.
export function withProviderFooter(text: string, providerKey: string | null | undefined): string {
  return providerKey === "txr" ? text + TXR_APPENDED_FOOTER : text;
}
