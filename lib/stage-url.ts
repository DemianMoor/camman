// Pure Full-URL builder for a campaign stage. NO database or server-only
// imports — shared by the stage form (live prefill) and the stage API routes
// (authoritative rebuild on save) so the two can never diverge.
//
// Shape (see CLAUDE.md §10g and the stage form):
//   <sales page URL>?sub_id3=<stage tracking ID>&<tag_id>=<value source>&…
//   e.g. https://www.guidekn.com/lp/orv?sub_id3=8_3_052726_1_s1_c101&subid5=facebook
//
// - Base is the SELECTED SALES PAGE's URL (the offer's affiliate/base_url is
//   intentionally NOT used here). No sales page ⇒ empty URL.
// - The stage tracking ID is ALWAYS carried by the fixed `sub_id3` param — this
//   is the key Keitaro is configured to ingest for attribution, the same for
//   every offer. (Bug 3: previously the per-offer `postfix` field drove the key,
//   but operators set it to page slugs like `knd`/`orv`, breaking attribution;
//   the param is now a system constant.) Omitted when there's no tracking ID yet.
// - Each selected UTM tag appends `&<tag_id>=<value_source>` (the tag_id is
//   the param name; value_source is the literal value).
// - Keys and values are URL-encoded. If the base already contains "?", params
//   are appended with "&".

// The query-param name that carries the stage tracking ID. Fixed system-wide so
// Keitaro attribution is consistent across offers. See lib/keitaro (sub_id_3).
export const STAGE_TRACKING_PARAM = "sub_id3";

// =============================================================================
// Destination-URL validation (guidekn shape guard)
//
// The canonical guidekn destination is exactly:
//   https://www.guidekn.com/lp/<slug>?sub_id3=<tracking_id>
//   - <slug>: lowercase letters and digits (e.g. "orv", "gb1") — no underscore
//   - exactly one query param, sub_id3, carrying the stage tracking id
//
// A string-concatenation bug historically produced malformed destinations (the
// tracking id glued into the path, an empty sub_id3, a `subid3=sub_id3`
// placeholder). Those ship a 404 to the recipient and silently kill attribution
// — the click is recorded here, the revenue never appears. `validateDestination`
// is the single source of truth for "is this a well-formed destination?"; it is
// wired into the stage form (block Save), the write routes (reject 4xx), the send
// path (rebuild instead of shipping garbage) and mirrored by a DB CHECK.
//
// SCOPE: the shape rule applies ONLY to guidekn /lp/ URLs. Empty URLs (drafts /
// auto-mode) and non-guidekn destinations (network URLs, other domains) pass —
// they are out of scope of the guidekn contract. This mirrors the DB CHECK's
// `url NOT LIKE '%guidekn.com/lp/%'` guard so the two never disagree.
// =============================================================================

// Any guidekn landing-page URL — the trigger for the shape rule.
const GUIDEKN_LP_RE = /guidekn\.com\/lp\//i;

// The canonical, well-formed guidekn destination.
export const GUIDEKN_DEST_RE =
  /^https:\/\/www\.guidekn\.com\/lp\/[a-z0-9]+\?sub_id3=[A-Za-z0-9_]+$/;

// True when `url` is subject to the guidekn shape rule (a guidekn /lp/ URL).
export function isGuideknLpUrl(url: string | null | undefined): boolean {
  return GUIDEKN_LP_RE.test((url ?? "").trim());
}

// Returns a human-readable error naming the SPECIFIC defect, or null when the
// URL is acceptable. `trackingId` is optional: when provided (and the URL is a
// well-formed guidekn destination) the sub_id3 value must equal it; when null
// only the structural shape is checked (used by write routes that validate
// before the stage's tracking id is known — the send path enforces equality).
export function validateDestination(
  url: string | null | undefined,
  trackingId?: string | null,
): string | null {
  const u = (url ?? "").trim();
  // Empty and non-guidekn destinations are out of scope of the shape rule.
  if (!u || !isGuideknLpUrl(u)) return null;

  // Defect A: tracking id concatenated into the path (…/lp/knd8_62_…). The
  // reliable signature is an UNDERSCORE in the /lp/ path segment — stage tracking
  // ids always contain them (e.g. 8_62_070826_1_s3_c126) while legit slugs are
  // plain alphanumerics (e.g. "orv", "gb1"). Keying off a trailing digit here
  // false-flagged digit-bearing slugs like "gb1".
  if (/\/lp\/[a-z0-9]*_/i.test(u)) {
    return "Tracking ID is concatenated into the path (…/lp/knd8_62_…). Expected …/lp/knd?sub_id3=8_62_…";
  }
  // Empty tracking value.
  if (/[?&]sub_id3=(&|$)/.test(u)) {
    return "sub_id3 is present but empty.";
  }
  // Defect C: unsubstituted template placeholder.
  if (/subid3=sub_id3/.test(u)) {
    return 'Unsubstituted template placeholder "subid3=sub_id3" in the URL.';
  }
  // No tracking param at all — this stage would be unattributable.
  if (!/[?&]sub_id3=/.test(u)) {
    return "URL has no sub_id3 parameter — this stage would be unattributable.";
  }
  // Anything else that isn't the exact canonical shape.
  if (!GUIDEKN_DEST_RE.test(u)) {
    return "URL does not match https://www.guidekn.com/lp/<slug>?sub_id3=<tracking_id>";
  }
  // Cross-field: sub_id3 must equal the owning stage's tracking id (when known).
  if (trackingId != null && trackingId !== "") {
    let got: string | null = null;
    try {
      got = new URL(u).searchParams.get("sub_id3");
    } catch {
      // Unreachable — GUIDEKN_DEST_RE already guarantees a parseable URL.
    }
    if (got !== trackingId) {
      return `sub_id3 is "${got}" but this stage's tracking_id is "${trackingId}".`;
    }
  }
  return null;
}

export type UtmTagForUrl = { tag_id: string; value_source: string };

export function buildStageFullUrl({
  salesPageUrl,
  trackingId,
  utmTags,
}: {
  salesPageUrl?: string | null;
  // `postfix` is intentionally no longer accepted — the tracking-ID key is the
  // STAGE_TRACKING_PARAM constant, not the per-offer postfix (Bug 3).
  trackingId?: string | null;
  utmTags?: UtmTagForUrl[] | null;
}): string {
  const base = (salesPageUrl ?? "").trim();
  if (!base) return "";

  const params: Array<[string, string]> = [];

  const tid = (trackingId ?? "").trim();
  if (tid) {
    params.push([STAGE_TRACKING_PARAM, tid]);
  }

  for (const tag of utmTags ?? []) {
    const key = (tag.tag_id ?? "").trim();
    if (!key) continue;
    params.push([key, (tag.value_source ?? "").trim()]);
  }

  if (params.length === 0) return base;

  const qs = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${qs}`;
}

// Surgically set ONE query param's value: replace the value of an existing
// `key=…` segment, or append `key=value` if the param is absent. Every other
// segment is preserved byte-for-byte (more surgical than re-serializing via
// URLSearchParams, which would normalize encoding of params we shouldn't touch).
// No-op on an empty URL or empty key. Used to rewrite a copied stage's inherited
// `sub_id3` to its OWN tracking ID without disturbing `sub_id1` (L2 attribution
// forwarding) or any other param. Handles "?" vs "&" separators.
export function setUrlParam(url: string, key: string, value: string): string {
  const u = (url ?? "").trim();
  const k = (key ?? "").trim();
  if (!u || !k) return u;

  const qIdx = u.indexOf("?");
  const encoded = `${encodeURIComponent(k)}=${encodeURIComponent(value)}`;
  if (qIdx < 0) {
    // No query string yet — append as the first param.
    return `${u}?${encoded}`;
  }

  const base = u.slice(0, qIdx);
  const query = u.slice(qIdx + 1);
  let replaced = false;
  const segs = query
    .split("&")
    .filter((seg) => seg.length > 0)
    .map((seg) => {
      const rawKey = seg.split("=")[0];
      let decoded = rawKey;
      try {
        decoded = decodeURIComponent(rawKey);
      } catch {
        // Malformed escape — compare against the raw key.
      }
      if (decoded === k) {
        replaced = true;
        return encoded;
      }
      return seg;
    });
  if (!replaced) segs.push(encoded);
  return `${base}?${segs.join("&")}`;
}

// Append `key=value` to the end of a URL string (no-op if `key` is already
// present, or if the URL is empty). Used when the operator clicks a UTM chip
// while the Full URL is in hand-edited (custom) mode.
export function appendUrlParam(
  url: string,
  key: string,
  value: string,
): string {
  const u = url.trim();
  if (!u || !key.trim()) return u;
  if (hasUrlParam(u, key)) return u;
  const sep = u.includes("?") ? "&" : "?";
  return `${u}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

// Remove the `key=…` segment from a URL's query string (custom-mode chip
// toggle-off). Leaves the rest of the query intact.
export function removeUrlParam(url: string, key: string): string {
  const qIdx = url.indexOf("?");
  if (qIdx < 0) return url;
  const base = url.slice(0, qIdx);
  const query = url.slice(qIdx + 1);
  const kept = query
    .split("&")
    .filter((seg) => seg.length > 0)
    .filter((seg) => {
      const rawKey = seg.split("=")[0];
      let decoded = rawKey;
      try {
        decoded = decodeURIComponent(rawKey);
      } catch {
        // Malformed escape — fall back to the raw key.
      }
      return decoded !== key;
    });
  return kept.length ? `${base}?${kept.join("&")}` : base;
}

// Append just a parameter NAME with a trailing "=" (no value), e.g. turns
// "https://x/lp" into "https://x/lp?sub_id5=". Uses "?" for the first param,
// "&" thereafter. A following appendRawValue() supplies the value. No-op on
// empty url/name.
export function appendParamName(url: string, name: string): string {
  const u = url.trim();
  const n = (name ?? "").trim();
  if (!u || !n) return u;
  const sep = u.includes("?") ? "&" : "?";
  return `${u}${sep}${n}=`;
}

// Append a raw value to the end of the URL (no key, no separator) — used by
// the tracking_id chip so the tracking ID lands right after the "=" of the
// parameter name added just before it.
export function appendRawValue(url: string, value: string): string {
  const v = (value ?? "").trim();
  if (!v) return url;
  return `${url}${v}`;
}

// Remove the first occurrence of a raw value substring (tracking_id toggle-off).
export function removeRawValue(url: string, value: string): string {
  const v = (value ?? "").trim();
  if (!v) return url;
  const i = url.indexOf(v);
  if (i < 0) return url;
  return url.slice(0, i) + url.slice(i + v.length);
}

export function hasUrlParam(url: string, key: string): boolean {
  const qIdx = url.indexOf("?");
  if (qIdx < 0) return false;
  return url
    .slice(qIdx + 1)
    .split("&")
    .some((seg) => {
      const rawKey = seg.split("=")[0];
      let decoded = rawKey;
      try {
        decoded = decodeURIComponent(rawKey);
      } catch {
        // ignore
      }
      return decoded === key;
    });
}
