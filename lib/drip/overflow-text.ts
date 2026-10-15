// Pure text for the "Why not routed" overflow lines (0210 day, 0213 hour).
// No server-only imports: the client component imports this.

/** Structural mirror of routing-eval's OverflowSkip (kind is absent on day-only / flag-off rows). */
export type OverflowSkipText = {
  campaign_id: number;
  campaign_name: string | null;
  detail: string;
  kind?: "day" | "hour";
};

/** "<name>: <detail>, overflowed to <winner>" — one per skip. A day skip's detail
 *  is "campaign full (X/Y today …)"; an hour skip's is "hour full (N/cap this hour)".
 *  Kind-less entries are day, so existing rows read byte-identically. */
export function overflowLines(skips: OverflowSkipText[], to: string): string[] {
  return skips.map((s) => `${s.campaign_name ?? `#${s.campaign_id}`}: ${s.detail}, overflowed to ${to}`);
}

/** O3: no same-tag candidate had hour room, so the best-ranked one took the lead anyway. */
export function hourFallbackLine(winner: string): string {
  return `routed to ${winner} although its hour is full — every same-tag candidate was hour-full (it queues)`;
}

/** All overflow-related lines for one winner: skips first, then the fallback note. */
export function routingNoteLines(
  skips: OverflowSkipText[], winner: string, hourFallback: boolean,
): string[] {
  return [...overflowLines(skips, winner), ...(hourFallback ? [hourFallbackLine(winner)] : [])];
}

/** Badge text for a candidate row: a fallback winner is routed, not "not eligible". */
export function candidateBadgeLabel(c: { eligible: boolean }, isFallbackWinner: boolean): string {
  return isFallbackWinner ? "routed (hour full)" : c.eligible ? "eligible" : "not eligible";
}
