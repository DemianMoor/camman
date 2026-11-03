import { TAGS } from "@/lib/messages/tags";
import { appendUrlParam } from "@/lib/stage-url";

// Per-stage "Add ZIP / State to URL" (migration 0229). PURE and CLIENT-SAFE —
// the stage form preview and the redirect (lib/links/resolve-click.ts, which
// owns the DB lookup) call the SAME appendGeoParams.
//
// The params are appended AT REDIRECT TIME, after sub_id1, exactly like sub_id1
// itself — the minted link_destinations URL never changes, so the landing-page
// report key, the shape regex / DB trigger and the SMS length are untouched.
//
// ⚠️ ONLY zip and state, ever (owner ruling 2026-11-03). Values pass through
// the {zip}/{state} tag normalizers (each value goes out twice: zip/st and
// sub_id_7/sub_id_8): a missing or invalid value OMITS that param
// for this recipient — it never blocks the redirect.

// UI flag (dark launch). OFF ⇒ the stage form shows no checkboxes and sends no
// flag in its payload, so stored values never change from the UI. The redirect
// is NOT gated — it honours whatever the stage row says (false everywhere until
// someone ticks a box with the flag on). Must be read as the literal
// `process.env.NEXT_PUBLIC_…` so Next inlines it into the browser bundle.
export function stageUrlGeoParamsUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_STAGE_URL_GEO_PARAMS_UI_ENABLED === "true";
}

/** Sample values for the stage form's live preview. */
export const GEO_PREVIEW_SAMPLE: GeoParams = { zip: "75201", state: "TX" };

/** Placeholder the preview shows where the redirect puts the recipient's sub_id1. */
export const SUB_ID1_PREVIEW_PLACEHOLDER = "<recipient id>";

export const URL_ZIP_PARAM = "zip";
export const URL_STATE_PARAM = "st";
// Same values again under tracker sub-id slots (owner ruling 2026-11-03).
export const URL_ZIP_SUBID_PARAM = "sub_id_7";
export const URL_STATE_SUBID_PARAM = "sub_id_8";

/** Hard cap on how long the lookup may hold a redirect. Fail-open past it. */
export const GEO_LOOKUP_BUDGET_MS = 150;

export interface GeoParams {
  zip: string | null;
  state: string | null;
}

export const NO_GEO: GeoParams = { zip: null, state: null };

/**
 * Append normalized `zip` / `st`, then the same values as `sub_id_7` / `sub_id_8`
 * (order: zip, st, sub_id_7, sub_id_8). Each key is skipped when already present
 * (hand-edited URL).
 */
export function appendGeoParams(url: string, geo: GeoParams): string {
  let out = url;
  const zip = TAGS.zip.normalize(geo.zip);
  const st = TAGS.state.normalize(geo.state);
  if (zip) out = appendUrlParam(out, URL_ZIP_PARAM, zip);
  if (st) out = appendUrlParam(out, URL_STATE_PARAM, st);
  if (zip) out = appendUrlParam(out, URL_ZIP_SUBID_PARAM, zip);
  if (st) out = appendUrlParam(out, URL_STATE_SUBID_PARAM, st);
  return out;
}

/**
 * Fail-open wrapper: resolves NO_GEO on error, on an empty result, or once
 * `budgetMs` passes — never rejects, never holds the redirect past the budget.
 */
export function lookupGeoParamsFailOpen(
  lookup: () => Promise<GeoParams>,
  budgetMs: number = GEO_LOOKUP_BUDGET_MS,
): Promise<GeoParams> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(NO_GEO), budgetMs);
    let p: Promise<GeoParams>;
    try {
      p = lookup();
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(
      (g) => {
        clearTimeout(timer);
        resolve(g);
      },
      (err) => {
        clearTimeout(timer);
        console.error("lookupGeoParams failed; redirecting without zip/st", err);
        resolve(NO_GEO);
      },
    );
  });
}

/**
 * What the recipient lands on, for the stage form preview: the destination +
 * the sub_id1 placeholder + the ticked params with sample values. Same
 * appendGeoParams as the redirect, so the preview cannot drift from it.
 */
export function previewLandingUrl(
  destination: string,
  flags: { zip: boolean; state: boolean },
): string {
  const d = destination.trim();
  if (!d) return "";
  // Placeholder written raw: appendUrlParam would percent-encode the brackets.
  const withSubId1 = /[?&]sub_id1=/.test(d)
    ? d
    : `${d}${d.includes("?") ? "&" : "?"}sub_id1=${SUB_ID1_PREVIEW_PLACEHOLDER}`;
  return appendGeoParams(withSubId1, {
    zip: flags.zip ? GEO_PREVIEW_SAMPLE.zip : null,
    state: flags.state ? GEO_PREVIEW_SAMPLE.state : null,
  });
}
