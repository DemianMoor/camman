import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { creative_offers, creatives, offers } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { generateCreativeSlug } from "@/lib/creative-helpers";
import { can } from "@/lib/permissions";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const SLUG_RETRY_LIMIT = 5;

// Duplicate a creative as an independent active row. Copies text + quality
// + sequence_placement + applies_to_all_offers + the junction offers, but
// uses a fresh slug, drops the source's creative_id (would conflict on the
// unique index), and starts with status='active' regardless of source state.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
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

  // Pull source offer associations.
  const sourceOffers = await db
    .select({ offer_id: creative_offers.offer_id })
    .from(creative_offers)
    .where(eq(creative_offers.creative_id, creativeId));

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
            quality: src.quality,
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
        { ...result, offers: offersArr },
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
