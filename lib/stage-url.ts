// Pure Full-URL builder for a campaign stage. NO database or server-only
// imports — shared by the stage form (live prefill) and the stage API routes
// (authoritative rebuild on save) so the two can never diverge.
//
// Shape (see CLAUDE.md §10g and the stage form):
//   <sales page URL>?<offer postfix>=<stage tracking ID>&<tag_id>=<value source>&…
//   e.g. https://www.guidekn.com/lp/orv?sub_id3=8_3_052726_1_s1_c101&subid5=facebook
//
// - Base is the SELECTED SALES PAGE's URL (the offer's affiliate/base_url is
//   intentionally NOT used here). No sales page ⇒ empty URL.
// - The offer's `postfix` is the query-param NAME that carries the stage
//   tracking ID. Omitted when the offer has no postfix or the stage has no
//   tracking ID yet.
// - Each selected UTM tag appends `&<tag_id>=<value_source>` (the tag_id is
//   the param name; value_source is the literal value).
// - Keys and values are URL-encoded. If the base already contains "?", params
//   are appended with "&".

export type UtmTagForUrl = { tag_id: string; value_source: string };

export function buildStageFullUrl({
  salesPageUrl,
  postfix,
  trackingId,
  utmTags,
}: {
  salesPageUrl?: string | null;
  postfix?: string | null;
  trackingId?: string | null;
  utmTags?: UtmTagForUrl[] | null;
}): string {
  const base = (salesPageUrl ?? "").trim();
  if (!base) return "";

  const params: Array<[string, string]> = [];

  const pf = (postfix ?? "").trim();
  const tid = (trackingId ?? "").trim();
  if (pf && tid) {
    params.push([pf, tid]);
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
