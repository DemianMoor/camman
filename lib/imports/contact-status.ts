// Smart reader that maps free-text contact-status values (from a CSV import on
// the Contacts screen) to one of the three contact statuses the operator can
// set in bulk. Each maps to an `opt_outs.reason` — a universal exclusion that
// keeps the number out of FUTURE audience snapshots org-wide.
//
// Mirrors the heuristic approach of lib/imports/outcome.ts (campaign-result
// imports), but the buckets and intent are different: this is a contact-level
// status cleanup, not a per-stage delivery outcome.
//
//   - 'opt_out'    — recipient unsubscribed / said STOP.
//   - 'suppressed' — Global Suppression / Do-Not-Contact list.
//   - 'scrubbed'   — provider flagged the number as non-mobile
//                    (landline, VoIP, invalid). Landline/VoIP collapse here.
//
// Anything unrecognized (or blank) returns null so the caller can skip the row
// and report it, rather than silently mis-classifying it.

export type ContactStatusReason = "opt_out" | "suppressed" | "scrubbed";

// Unsubscribe / STOP family. Mirrors HEURISTIC_OPT_OUT in outcome.ts.
const OPT_OUT_WORDS = new Set([
  "opt_out",
  "opt-out",
  "opt out",
  "optout",
  "opt_outs",
  "opt-outs",
  "opt outs",
  "optouts",
  "unsub",
  "unsubs",
  "unsubscribe",
  "unsubscribes",
  "unsubscribed",
  "unsubscribing",
  "stop",
  "stops",
  "stopped",
  "stopping",
  "removed",
  "remove",
  "blocked",
]);

// Global Suppression / Do-Not-Contact family.
const SUPPRESSED_WORDS = new Set([
  "suppress",
  "suppressed",
  "suppression",
  "global suppression",
  "globally suppressed",
  "global suppress",
  "dnc",
  "do not contact",
  "do-not-contact",
  "do_not_contact",
  "donotcontact",
  "do not call",
  "do-not-call",
  "do_not_call",
  "donotcall",
  "blacklist",
  "blacklisted",
  "black list",
  "suppress list",
  "suppression list",
]);

// Non-mobile scrub family — Landline & VoIP collapse into a single 'scrubbed'.
const SCRUBBED_WORDS = new Set([
  "scrub",
  "scrubbed",
  "landline",
  "land line",
  "land-line",
  "fixed line",
  "fixed-line",
  "fixedline",
  "voip",
  "voice over ip",
  "invalid",
  "not_mobile",
  "not-mobile",
  "not mobile",
  "non_mobile",
  "non-mobile",
  "non mobile",
  "nonmobile",
]);

// Collapse separators/whitespace so "Opt-Out", "opt_out" and "OPT OUT" all
// normalize to a single comparable form. We keep a single-space form for
// multi-word phrases ("do not contact") and also test the separator-stripped
// form ("donotcontact"), so the word sets above can list either shape.
function normalizeStatus(raw: string): { spaced: string; stripped: string } {
  const spaced = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .trim();
  const stripped = spaced.replace(/\s+/g, "");
  return { spaced, stripped };
}

function matches(
  set: ReadonlySet<string>,
  spaced: string,
  stripped: string,
): boolean {
  for (const w of set) {
    const wSpaced = w.replace(/[\s_-]+/g, " ").trim();
    const wStripped = wSpaced.replace(/\s+/g, "");
    if (spaced === wSpaced || stripped === wStripped) return true;
  }
  return false;
}

// Map a raw status string to a contact-status reason, or null if unrecognized.
//
// Priority when a value somehow matches more than one bucket: opt_out >
// suppressed > scrubbed. Opt-out is the recipient's explicit instruction and
// the strongest signal; suppression is a deliberate org-level block; scrubbing
// is a technical (provider) classification.
export function mapContactStatus(
  raw: string | null | undefined,
): ContactStatusReason | null {
  if (raw == null) return null;
  const { spaced, stripped } = normalizeStatus(raw);
  if (spaced.length === 0) return null;

  if (matches(OPT_OUT_WORDS, spaced, stripped)) return "opt_out";
  if (matches(SUPPRESSED_WORDS, spaced, stripped)) return "suppressed";
  if (matches(SCRUBBED_WORDS, spaced, stripped)) return "scrubbed";
  return null;
}

// Priority for collapsing duplicate phone numbers within a single import: when
// the same number appears with different statuses, the highest-priority reason
// wins. opt_out (recipient said STOP) > suppressed (org block) > scrubbed
// (technical). All three exclude the contact from future audiences, so the
// choice only affects which status badge/reporting bucket the contact lands in.
export const CONTACT_STATUS_PRIORITY: Record<ContactStatusReason, number> = {
  opt_out: 3,
  suppressed: 2,
  scrubbed: 1,
};

// Human labels for the three statuses — used in the import preview and result
// summary so the UI doesn't duplicate the mapping.
export const CONTACT_STATUS_LABELS: Record<ContactStatusReason, string> = {
  opt_out: "Opt-out",
  suppressed: "Suppressed",
  scrubbed: "Scrubbed",
};
