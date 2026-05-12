import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { creatives } from "@/db/schema";
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

  // The duplicate is an independent record: fresh slug, fresh status (draft),
  // no creative_id (would conflict with the source's unique value), and no
  // archived_at carry-over. offer/provider/brand/text are copied verbatim.
  for (let attempt = 0; attempt < SLUG_RETRY_LIMIT; attempt++) {
    try {
      const slug = generateCreativeSlug();
      const [created] = await db
        .insert(creatives)
        .values({
          org_id: orgId,
          offer_id: source[0].offer_id,
          sms_provider_id: source[0].sms_provider_id,
          brand_id: source[0].brand_id,
          text: source[0].text,
          creative_id: null,
          slug,
          status: "draft",
        })
        .returning();
      return NextResponse.json(created, { status: 201 });
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
