// THE single source of truth for tracked-link construction and short-domain
// precedence — shared by the send path and by every preview.
//
// PURE and CLIENT-SAFE: no node:crypto, no nanoid, no db import. That is the
// whole point. lib/links/mint-link.ts (which pulls in node:crypto + nanoid)
// cannot be imported from a "use client" component, which is exactly why the
// stage form used to hardcode its own copy of the code length as the literal
// "XXXXXXX" with a comment promising it equalled CODE_LENGTH. A promise in a
// comment is not a constraint; this module makes it one.
//
// B2 exists because preview and kickoff each built the link string themselves:
//   stage form : `https://${campaign.brand.short_domain}/r/XXXXXXX`
//   kickoff    : `https://${resolveShortDomainForSend(...)}/r/${code}`
// Those disagree in TWO ways — a hardcoded length, and a domain resolved by
// different rules (the preview never saw the stage's per-phone override). Since
// the link sits inside the counted body, a disagreement silently shifts the
// GSM-7 segment boundary: gdkn.org is 8 characters, g.guidekn.com is 13, so the
// same creative can preview as 1 segment and send as 2 — at double the cost,
// with nothing on screen to show it.

// Length of a minted short code. mint-link.ts imports this rather than
// declaring its own, so the generator and every length estimate move together.
export const TRACKED_CODE_LENGTH = 7;

// The on-wire tracked link. ONE definition of the shape `https://<host>/r/<code>`.
export function buildTrackedLinkUrl(domain: string, code: string): string {
  return `https://${domain}/r/${code}`;
}

// A length-accurate stand-in used wherever the real code does not exist yet —
// the operator's live preview, and kickoff's pre-materialization segment gate.
// Every minted code is exactly TRACKED_CODE_LENGTH characters, so this string
// has the same length as the real thing and the segment count derived from it
// is exact rather than approximate.
export function buildRepresentativeTrackedLinkUrl(domain: string): string {
  return buildTrackedLinkUrl(domain, "X".repeat(TRACKED_CODE_LENGTH));
}

// THE short-domain precedence rule, as a pure function of already-resolved
// candidates. Both callers reduce to this:
//
//   server (lib/sends/resolve-short-domain.ts) — runs the DB lookups, then calls this
//   client (stage form)                        — receives both candidates over the API, then calls this
//
// Keeping the ORDER here, rather than in each caller, is what stops the preview
// and the send path from disagreeing about which host wins. The inputs must
// already be filtered to status='active': a pending domain is never mintable,
// so it must reach this function as null, not as a candidate to rank.
export function pickEffectiveShortDomain(opts: {
  /** The stage's sending number's own override — ACTIVE only, else null. */
  phoneOverrideDomain?: string | null;
  /** The brand's effective domain — explicit default first, else oldest active. */
  brandDefaultDomain?: string | null;
}): string | null {
  const phone = (opts.phoneOverrideDomain ?? "").trim();
  if (phone.length > 0) return phone;
  const brand = (opts.brandDefaultDomain ?? "").trim();
  return brand.length > 0 ? brand : null;
}
