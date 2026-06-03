// Minimal, dependency-free click classification for the redirect endpoint.
// The invariant is classify-don't-delete: every click is logged and
// redirected; this label only decides whether a click is COUNTED at report
// time. Full bot scoring is Phase 3 — this is the cheap first pass.

export type ClickClassification = "human" | "bot" | "prefetch" | "unknown";

// Browsers/link-preview crawlers announce speculative fetches through these
// headers. Any of them ⇒ the "click" wasn't a human tapping the link.
export interface PrefetchSignals {
  // `Purpose: prefetch`, `X-Purpose: preview`, `X-Moz: prefetch`,
  // `Sec-Purpose: prefetch;prerender`, etc.
  purpose?: string | null;
  xPurpose?: string | null;
  xMoz?: string | null;
  secPurpose?: string | null;
}

// Substrings that mark an automated client. Kept deliberately small and
// high-signal; expand in Phase 3 rather than chasing every UA here.
const BOT_UA_PATTERN =
  /bot|crawler|spider|crawl|slurp|mediapartners|facebookexternalhit|whatsapp|telegrambot|discordbot|bingpreview|google-?(?:bot|other)|headless|phantomjs|curl|wget|python-requests|libwww|httpclient|go-http-client|axios|node-fetch|okhttp|java\//i;

function looksLikePrefetch(s: PrefetchSignals): boolean {
  const haystacks = [s.purpose, s.xPurpose, s.xMoz, s.secPurpose];
  return haystacks.some((h) => {
    if (!h) return false;
    const v = h.toLowerCase();
    return v.includes("prefetch") || v.includes("preview") || v.includes("prerender");
  });
}

export function classifyClick(
  userAgent: string | null | undefined,
  prefetch: PrefetchSignals = {},
): ClickClassification {
  if (looksLikePrefetch(prefetch)) return "prefetch";

  const ua = (userAgent ?? "").trim();
  if (!ua) return "unknown";
  if (BOT_UA_PATTERN.test(ua)) return "bot";
  return "human";
}
