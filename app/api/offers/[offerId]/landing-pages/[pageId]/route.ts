import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { offer_landing_pages } from "@/db/schema";
import { apiError, isUniqueViolation, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { offerLandingPageUpdateSchema } from "@/lib/validators/offer-landing-pages";

function parseId(v: string) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
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
    const row = await db.transaction(async (tx) => {
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
      if (!existing[0]) return null;

      // ⚠️ `kind` is NOT updatable. Flipping a live page from slug to
      // external_url (or back) would silently change where every stage already
      // pointing at it will send — including stages already approved. Make a new
      // page and disable the old one instead; the slug stays reserved, so old
      // links keep meaning what they meant.
      if (existing[0].kind === "slug" && input.external_url !== undefined) {
        return { conflict: "kind_immutable" as const };
      }
      if (existing[0].kind === "external_url" && input.slug !== undefined) {
        return { conflict: "kind_immutable" as const };
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
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.external_url !== undefined ? { external_url: input.external_url } : {}),
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
      return updated[0];
    });

    if (!row) {
      return apiError(404, "Landing page not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "offer_landing_page",
      });
    }
    if ("conflict" in row) {
      return apiError(
        400,
        "A landing page's kind cannot change — create a new page and disable this one",
        API_ERROR_CODES.VALIDATION,
        { field: "kind" },
      );
    }
    return NextResponse.json(row);
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
