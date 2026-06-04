// Opt-out keyword detection for inbound SMS (STOP intake).
//
// Matches the carrier-standard mandatory opt-out keywords plus a few common
// variants. A message counts as an opt-out when its FIRST word is one of these
// (case-insensitive), which tolerates trailing text/emoji seen in real inbox
// data ("STOP ✋️", "Stop please"). Opt-IN keywords (START/UNSTOP/YES) are
// intentionally NOT handled here — re-subscription is out of scope for v1.

const OPT_OUT_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "OPTOUT",
  "OPT-OUT",
  "REVOKE",
]);

// True if the message's first token is a recognized opt-out keyword. Strips
// surrounding punctuation/emoji from that token before comparing (keeps letters
// and an internal hyphen for "OPT-OUT").
export function isOptOutKeyword(message: string): boolean {
  if (!message) return false;
  const firstToken = message.trim().split(/\s+/)[0] ?? "";
  const cleaned = firstToken.toUpperCase().replace(/[^A-Z-]/g, "");
  if (!cleaned) return false;
  return OPT_OUT_KEYWORDS.has(cleaned);
}
