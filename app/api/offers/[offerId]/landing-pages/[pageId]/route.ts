import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { offer_landing_pages, type OfferLandingPage } from "@/db/schema";
import { apiError, isUniqueViolation, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { LANDING_PAGE_INVALID_CODE } from "@/lib/api/landing-page-guard";
import { computeLandingPageImpact } from "@/lib/api/landing-page-impact";
import {
  LANDING_PAGE_IN_USE_CODE,
  resolveLandingPageEdit,
  type LandingPageKind,
} from "@/lib/landing-page-edit";
import { can } from "@/lib/permissions";
import { offerLandingPageUpdateSchema } from "@/lib/validators/offer-landing-pages";

function parseId(v: string) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

type Outcome =
  | { outcome: "ok"; row: OfferLandingPage }
  | { outcome: "not_found" }
  | { outcome: "refused"; status: number; message: string; code: string; details: unknown };

function refused(status: number, message: string, code: string, details: unknown): Outcome {
  return { outcome: "refused", status, message, code, details };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string; pageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "offers.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { offerId: op, pageId: pp } = await params;
  const offerId = parseId(op);
  const pageId = parseId(pp);
  if (offerId === null || pageId === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = offerLandingPageUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
      { field: parsed.error.issues[0]?.path.join(".") },
    );
  }
  const input = parsed.data;

  try {
    const result = await db.transaction(async (tx): Promise<Outcome> => {
      const existing = await tx
        .select()
        .from(offer_landing_pages)
        .where(
          and(
            eq(offer_landing_pages.id, pageId),
            eq(offer_landing_pages.offer_id, offerId),
            eq(offer_landing_pages.org_id, orgId),
          ),
        )
        .limit(1);
      const page = existing[0];
      if (!page) return { outcome: "not_found" };

      const dest = resolveLandingPageEdit(
        { kind: page.kind as LandingPageKind, slug: page.slug, external_url: page.external_url },
        input,
      );
      if (!dest.ok) {
        return refused(400, dest.message, API_ERROR_CODES.VALIDATION, { field: dest.field });
      }

      // ⚠️ The destination is built from these columns when links are MINTED, so
      // an edit reaches every stage not yet materialized and every dripping
      // stage — including approved ones. `kind` was immutable for that reason
      // until 2026-09-17; it is now editable (ruled), but only after the caller
      // has seen how many stages it reaches.
      if (dest.destinationChanged) {
        const impact = await computeLandingPageImpact(tx, { orgId, pageId });
        // Not overridable by `confirm`: a slug page on a brand with no
        // landing_host hard-fails at mint — the rule checkStageLandingPage
        // enforces at stage save.
        if (page.kind !== "slug" && dest.kind === "slug" && impact.brandsWithoutLandingHost.length > 0) {
          const brands = impact.brandsWithoutLandingHost.join(", ");
          return refused(
            400,
            `Can't switch "${page.title}" to a brand slug page: it is used by stages on ${brands}, ` +
              `which has no landing host to build the link from. Set the brand's landing host first.`,
            LANDING_PAGE_INVALID_CODE,
            { field: "kind", brands: impact.brandsWithoutLandingHost },
          );
        }
        if (impact.affected > 0 && input.confirm !== true) {
          return refused(
            409,
            `${impact.affected} stage(s) that haven't sent yet use this landing page ` +
              `(${impact.committed} approved, scheduled or dripping). Confirm to change where they link.`,
            LANDING_PAGE_IN_USE_CODE,
            { affected: impact.affected, committed: impact.committed },
          );
        }
      }

      if (input.is_default === true) {
        await tx
          .update(offer_landing_pages)
          .set({ is_default: false, updated_at: new Date() })
          .where(
            and(
              eq(offer_landing_pages.org_id, orgId),
              eq(offer_landing_pages.offer_id, offerId),
              eq(offer_landing_pages.is_default, true),
            ),
          );
      }

      const updated = await tx
        .update(offer_landing_pages)
        .set({
          ...(input.title !== undefined ? { title: input.title } : {}),
          kind: dest.kind,
          slug: dest.slug,
          external_url: dest.external_url,
          ...(input.is_default !== undefined ? { is_default: input.is_default } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          updated_at: new Date(),
        })
        .where(
          and(
            eq(offer_landing_pages.id, pageId),
            eq(offer_landing_pages.org_id, orgId),
          ),
        )
        .returning();
      return { outcome: "ok", row: updated[0] };
    });

    if (result.outcome === "not_found") {
      return apiError(404, "Landing page not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "offer_landing_page",
      });
    }
    if (result.outcome === "refused") {
      return apiError(result.status, result.message, result.code, result.details);
    }
    return NextResponse.json(result.row);
  } catch (e) {
    if (isUniqueViolation(e)) {
      return apiError(
        409,
        "That slug is already used by another landing page on this offer",
        API_ERROR_CODES.DUPLICATE,
        { field: "slug" },
      );
    }
    throw e;
  }
}

// No DELETE. A landing page is referenced by campaign_stages.landing_page_id;
// deleting it would SET NULL and silently drop those stages back to the legacy
// absolute-URL path — a behaviour change the operator never asked for. Disable
// it instead (status='disabled'): the slug stays reserved so old links keep
// their meaning, and the send path refuses a disabled page rather than
// substituting something else.
