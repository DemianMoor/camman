// Resolves a landing page edit into the row's new destination columns.
//
// PURE (no DB, no Next imports) so scripts/test-landing-page-edit-resolver.ts
// can test it with plain tsx — the same split lib/entity-name.ts uses.
//
// A page's destination is `kind` + the ONE value that kind uses. The other
// column must be NULL (offer_landing_pages_shape_check), so switching kind
// needs the new value and clears the old one.

// 409 from the landing page PATCH: the destination edit reaches stages that
// haven't sent yet; resend with `confirm: true`. Lives here (not beside the
// impact query) so the client panel can import it without pulling in drizzle.
export const LANDING_PAGE_IN_USE_CODE = "landing_page_in_use";

export type LandingPageKind = "slug" | "external_url";

export interface LandingPageDestination {
  kind: LandingPageKind;
  slug: string | null;
  external_url: string | null;
}

export type LandingPageEditResolution =
  | (LandingPageDestination & { ok: true; destinationChanged: boolean })
  | { ok: false; field: "slug" | "external_url"; message: string };

export function resolveLandingPageEdit(
  existing: LandingPageDestination,
  input: { kind?: LandingPageKind; slug?: string; external_url?: string },
): LandingPageEditResolution {
  const kind = input.kind ?? existing.kind;

  if (kind === "slug") {
    if (input.external_url !== undefined) {
      return { ok: false, field: "external_url", message: "A slug landing page has no URL" };
    }
    const slug = input.slug ?? existing.slug;
    if (!slug) {
      return { ok: false, field: "slug", message: "Switching to a brand slug page needs a slug" };
    }
    return {
      ok: true,
      kind,
      slug,
      external_url: null,
      destinationChanged: existing.kind !== kind || existing.slug !== slug,
    };
  }

  if (input.slug !== undefined) {
    return { ok: false, field: "slug", message: "An external URL landing page has no slug" };
  }
  const externalUrl = input.external_url ?? existing.external_url;
  if (!externalUrl) {
    return { ok: false, field: "external_url", message: "Switching to an external URL page needs a URL" };
  }
  return {
    ok: true,
    kind,
    slug: null,
    external_url: externalUrl,
    destinationChanged: existing.kind !== kind || existing.external_url !== externalUrl,
  };
}
