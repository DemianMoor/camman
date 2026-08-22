import { and, asc, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { offer_landing_pages, offers } from "@/db/schema";
import { apiError, isUniqueViolation, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { offerLandingPageCreateSchema } from "@/lib/validators/offer-landing-pages";

// Landing pages for one offer (Drip P1 1b, migration 0150).
//
// Nested under the offer with the [offerId] segment name per CLAUDE.md §8
// (Next.js forbids sibling dynamic segments with different names).

function parseId(v: string) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "offers.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const { offerId: p } = await params;
  const offerId = parseId(p);
  if (offerId === null) {
    return apiError(400, "Invalid offer id", API_ERROR_CODES.VALIDATION, { field: "offerId" });
  }

  const rows = await db
    .select()
    .from(offer_landing_pages)
    .where(
      and(eq(offer_landing_pages.org_id, orgId), eq(offer_landing_pages.offer_id, offerId)),
    )
    // Default first, then active before disabled, then title — so the stage
    // picker can preselect without a second pass and a disabled page never
    // outranks a usable one.
    .orderBy(
      drizzleSql`${offer_landing_pages.is_default} DESC`,
      drizzleSql`(${offer_landing_pages.status} = 'active') DESC`,
      asc(offer_landing_pages.title),
    );

  return NextResponse.json({ data: rows });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  // Same gate as editing the offer itself — a landing page is offer config.
  if (!can(role, "offers.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const { offerId: p } = await params;
  const offerId = parseId(p);
  if (offerId === null) {
    return apiError(400, "Invalid offer id", API_ERROR_CODES.VALIDATION, { field: "offerId" });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = offerLandingPageCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
      { field: parsed.error.issues[0]?.path.join(".") },
    );
  }
  const input = parsed.data;

  // Offer ownership — RLS is defense in depth, app-level filtering is primary.
  const owned = await db
    .select({ id: offers.id })
    .from(offers)
    .where(and(eq(offers.id, offerId), eq(offers.org_id, orgId)))
    .limit(1);
  if (!owned[0]) {
    return apiError(400, "offer_id doesn't belong to your organization", API_ERROR_CODES.VALIDATION, {
      field: "offerId",
    });
  }

  try {
    const row = await db.transaction(async (tx) => {
      if (input.is_default) {
        // Clear + set must share a transaction: the one-default-per-offer
        // partial unique index rejects the insert otherwise, and a committed
        // clear with a failed insert would leave the offer with no default.
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
      const inserted = await tx
        .insert(offer_landing_pages)
        .values({
          org_id: orgId,
          offer_id: offerId,
          title: input.title,
          kind: input.kind,
          slug: input.kind === "slug" ? input.slug : null,
          external_url: input.kind === "external_url" ? input.external_url : null,
          is_default: input.is_default ?? false,
          status: input.status ?? "active",
        })
        .returning();
      return inserted[0];
    });
    return NextResponse.json(row, { status: 201 });
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
