// Pure Full-URL builder for a campaign stage. NO database or server-only
// imports — shared by the stage form (live prefill) and the stage API routes
// (authoritative rebuild on save) so the two can never diverge.
//
// Shape (see CLAUDE.md §10g and the stage form):
//   <sales page URL>?<offer postfix>=<stage tracking ID>&<label>=<value source>&…
//   e.g. https://www.guidekn.com/lp/orv?sub_id3=8_3_052726_1_s1_c101&utm_source=facebook
//
// - Base is the selected sales page's URL; falls back to the offer's base_url
//   when no sales page is chosen. Empty base ⇒ empty URL (nothing to build on).
// - The offer's `postfix` is the query-param NAME that carries the stage
//   tracking ID. Omitted when the offer has no postfix or the stage has no
//   tracking ID yet.
// - Each selected UTM tag appends `&<label>=<value_source>` (literal).
// - Keys and values are URL-encoded. If the base already contains "?", params
//   are appended with "&".

export type UtmTagForUrl = { label: string; value_source: string };

export function buildStageFullUrl({
  salesPageUrl,
  baseUrl,
  postfix,
  trackingId,
  utmTags,
}: {
  salesPageUrl?: string | null;
  baseUrl?: string | null;
  postfix?: string | null;
  trackingId?: string | null;
  utmTags?: UtmTagForUrl[] | null;
}): string {
  const base = (salesPageUrl ?? "").trim() || (baseUrl ?? "").trim();
  if (!base) return "";

  const params: Array<[string, string]> = [];

  const pf = (postfix ?? "").trim();
  const tid = (trackingId ?? "").trim();
  if (pf && tid) {
    params.push([pf, tid]);
  }

  for (const tag of utmTags ?? []) {
    const key = (tag.label ?? "").trim();
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
