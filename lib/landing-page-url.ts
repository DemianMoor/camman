import { STAGE_TRACKING_PARAM } from "@/lib/stage-url";

// Landing-page destination construction (Drip Phase 1, item 1b).
//
// PURE — no DB, no server imports — so the stage editor's read-only preview and
// the send path's mint both call the SAME function. If they diverged, the
// operator would approve one URL and the recipient would receive another.
//
// ⚠️ CONSTRUCTION HAPPENS AT MINT TIME, NOT SAVE TIME. The stage stores
// `landing_page_id`; the URL is built when links are minted, from the campaign's
// brand AT THAT MOMENT. That is the whole point: on 2026-08-22 two campaigns
// were re-branded (902 Guide Kin→LumZen, 923 FitsYou→LumZen) and every stage
// kept pointing at the old brand's pages, because the destination was a frozen
// absolute URL. Building it late makes a rebrand self-correcting.
//
// ⚠️ ON /lp/ DESTINATIONS, UTM TAGS ARE NEVER APPENDED. The canonical shape
// allows exactly ONE query param (sub_id3), which already carries tracking, and
// the one UTM tag configured in this org emits the literal `subid3=sub_id3` —
// the very "unsubstituted placeholder" defect validateDestination names and the
// single row that fails the 0151 CHECK. Tags remain available on
// kind='external_url' destinations, where no shape rule applies.

export type LandingPageKind = "slug" | "external_url";

export interface LandingPageRef {
  id: number;
  kind: LandingPageKind;
  slug: string | null;
  external_url: string | null;
  status: string;
}

export type LandingUrlResult =
  | { ok: true; url: string; appliedUtm: boolean }
  | { ok: false; reason: LandingUrlRefusal; message: string };

export type LandingUrlRefusal =
  | "page_disabled"
  | "brand_missing_landing_host"
  | "page_malformed";

/**
 * Build a stage's destination from its landing page + the campaign's brand.
 *
 * `landingHost` is `brands.landing_host` — a normalized bare host. It is NOT
 * `brands.website`, which is unnormalized (mixed `www.`, mixed trailing slash)
 * and is separately consumed verbatim by the bare-root redirect.
 *
 * Refuses rather than guessing. A brand with no landing_host cannot produce a
 * slug URL, and inventing one (prefixing `www.`, say) would ship a 404 that
 * silently kills attribution — the exact failure migration 0094 exists to stop.
 */
export function buildLandingPageUrl(opts: {
  page: LandingPageRef;
  landingHost: string | null | undefined;
  trackingId: string | null | undefined;
  /** UTM tags — applied to external_url destinations ONLY. See header. */
  utmTags?: { tag_id: string; value_source: string }[] | null;
}): LandingUrlResult {
  const { page, trackingId } = opts;

  if (page.status !== "active") {
    return {
      ok: false,
      reason: "page_disabled",
      message: `Landing page ${page.id} is disabled and cannot be used for a new send.`,
    };
  }

  if (page.kind === "slug") {
    const host = (opts.landingHost ?? "").trim().toLowerCase();
    if (!host) {
      return {
        ok: false,
        reason: "brand_missing_landing_host",
        message:
          "This campaign's brand has no landing host set, so a slug-based landing page cannot be used. " +
          "Set the brand's landing host, or pick an external-URL landing page.",
      };
    }
    const slug = (page.slug ?? "").trim();
    if (!/^[a-z0-9]+$/.test(slug)) {
      return {
        ok: false,
        reason: "page_malformed",
        message: `Landing page ${page.id} has an invalid slug ("${slug}"). Expected lowercase letters and digits only.`,
      };
    }
    const tid = (trackingId ?? "").trim();
    // Single param, always sub_id3. No UTM — see the header note.
    const qs = tid ? `?${STAGE_TRACKING_PARAM}=${encodeURIComponent(tid)}` : "";
    return { ok: true, url: `https://${host}/lp/${slug}${qs}`, appliedUtm: false };
  }

  // kind === "external_url": the stored URL verbatim, any brand. No shape rule
  // applies, so UTM tags ARE honoured here.
  const base = (page.external_url ?? "").trim();
  if (!base) {
    return {
      ok: false,
      reason: "page_malformed",
      message: `Landing page ${page.id} is an external URL but has no URL set.`,
    };
  }
  const params: string[] = [];
  const tid = (trackingId ?? "").trim();
  if (tid) params.push(`${STAGE_TRACKING_PARAM}=${encodeURIComponent(tid)}`);
  let appliedUtm = false;
  for (const tag of opts.utmTags ?? []) {
    const key = (tag.tag_id ?? "").trim();
    if (!key) continue;
    params.push(`${encodeURIComponent(key)}=${encodeURIComponent((tag.value_source ?? "").trim())}`);
    appliedUtm = true;
  }
  if (params.length === 0) return { ok: true, url: base, appliedUtm: false };
  const sep = base.includes("?") ? "&" : "?";
  return { ok: true, url: `${base}${sep}${params.join("&")}`, appliedUtm };
}

/**
 * Is this host one of the org's brand landing hosts?
 *
 * Used by the LEGACY (landing_page_id NULL) auto-build path to decide whether to
 * append UTM tags: on a brand landing host the single-param rule applies, so
 * tags are skipped there too. Without this, re-saving one of the 261 UTM-tagged
 * `/lp/` stages in auto mode would append `subid3=sub_id3` and be rejected on
 * Save — a latent break that predates 1b.
 */
export function isBrandLandingHost(
  url: string | null | undefined,
  landingHosts: readonly (string | null | undefined)[],
): boolean {
  const u = (url ?? "").trim();
  if (!u) return false;
  const m = u.match(/^https?:\/\/([^/?#]+)/i);
  if (!m) return false;
  const host = m[1].toLowerCase();
  return landingHosts.some((h) => !!h && h.trim().toLowerCase() === host);
}
