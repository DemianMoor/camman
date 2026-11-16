import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { creative_offers, creatives, offer_brands, offers } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { generateCreativeSlug } from "@/lib/creative-helpers";
import { brandBelongsToOrg } from "@/lib/creatives/brand";
import { can } from "@/lib/permissions";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const SLUG_RETRY_LIMIT = 5;

// "Copy to brand" (0240, ClickUp 1amdve2d47v): duplicate a creative as an
// independent active row ASSIGNED TO `brand_id` (required; may equal the
// source's brand, which is a plain duplicate). Copies text + sequence_placement
// + funnel_stage + applies_to_all_offers, and ONLY the source offers that are
// allowed under the target brand (offer_brands) — a copy linked to an offer its
// brand can't run would never appear in a picker. If the source has offers and
// none is allowed, the copy is refused with a plain message. Fresh slug, no
// creative_id (unique index), status 'active'. The copy is a new creative: new
// id, no stats, unproven, not linked to the original for content dedup.
const copyBodySchema = z.object({
  brand_id: z.number({ error: "Pick the brand to copy to" }).int().positive("Pick the brand to copy to"),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership({
    route: "creatives/[id]/duplicate",
    method: "POST",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "creatives.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const creativeId = parseId(id);
  if (creativeId === null) {
    return apiError(400, "Invalid creative id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const parsedBody = copyBodySchema.safeParse(body);
  if (!parsedBody.success) {
    return apiError(400, parsedBody.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION, {
      field: "brand_id",
    });
  }
  const targetBrandId = parsedBody.data.brand_id;
  if (!(await brandBelongsToOrg(orgId, targetBrandId))) {
    return apiError(400, "brand_id doesn't belong to your organization", API_ERROR_CODES.VALIDATION, {
      field: "brand_id",
    });
  }

  const source = await db
    .select()
    .from(creatives)
    .where(and(eq(creatives.id, creativeId), eq(creatives.org_id, orgId)))
    .limit(1);
  if (!source[0]) {
    return apiError(404, "Creative not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "creative",
    });
  }
  const src = source[0];

  // Pull source offer associations, then keep only those the target brand may run.
  const allSourceOffers = await db
    .select({ offer_id: creative_offers.offer_id })
    .from(creative_offers)
    .where(eq(creative_offers.creative_id, creativeId));
  const allowed =
    allSourceOffers.length === 0
      ? []
      : await db
          .select({ offer_id: offer_brands.offer_id })
          .from(offer_brands)
          .where(
            and(
              eq(offer_brands.org_id, orgId),
              eq(offer_brands.brand_id, targetBrandId),
              inArray(offer_brands.offer_id, allSourceOffers.map((o) => o.offer_id)),
            ),
          );
  const allowedIds = new Set(allowed.map((a) => a.offer_id));
  const sourceOffers = allSourceOffers.filter((o) => allowedIds.has(o.offer_id));
  if (allSourceOffers.length > 0 && sourceOffers.length === 0) {
    return apiError(
      400,
      "None of this creative's offers is assigned to that brand. Assign the offer to the brand first (Offers → edit the offer → Assigned brands), then copy again.",
      API_ERROR_CODES.VALIDATION,
      { reason: "no_offer_allowed_under_brand", field: "brand_id" },
    );
  }

  for (let attempt = 0; attempt < SLUG_RETRY_LIMIT; attempt++) {
    try {
      const slug = generateCreativeSlug();
      const result = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(creatives)
          .values({
            org_id: orgId,
            text: src.text,
            creative_id: null,
            slug,
            brand_id: targetBrandId,
            sequence_placement: src.sequence_placement,
            funnel_stage: src.funnel_stage,
            applies_to_all_offers: src.applies_to_all_offers,
            // allow_multi_segment is DELIBERATELY NOT copied — it resets to the
            // default (false) on a duplicate. A copy may be edited longer, so the
            // segment-policy override must be re-reviewed/re-enabled explicitly
            // rather than silently inherited. (Do not "fix" by copying it.)
            status: "active",
          })
          .returning();
        if (sourceOffers.length > 0) {
          await tx.insert(creative_offers).values(
            sourceOffers.map(({ offer_id }) => ({
              creative_id: created.id,
              offer_id,
              org_id: orgId,
            })),
          );
        }
        return created;
      });

      // Hydrate offers for the response.
      const offersArr = await db
        .select({
          id: offers.id,
          name: offers.name,
          color: offers.color,
          avatar_url: offers.avatar_url,
        })
        .from(creative_offers)
        .innerJoin(offers, eq(offers.id, creative_offers.offer_id))
        .where(eq(creative_offers.creative_id, result.id));
      return NextResponse.json(
        {
          ...result,
          offers: offersArr,
          // Offers the copy did NOT keep because the target brand can't run them.
          dropped_offer_ids: allSourceOffers.filter((o) => !allowedIds.has(o.offer_id)).map((o) => o.offer_id),
        },
        { status: 201 },
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Slug collision — retry. creative_id is null so it can't be the source.
    }
  }
  return apiError(
    500,
    "Couldn't generate a unique slug after several retries",
    API_ERROR_CODES.INTERNAL,
  );
}
