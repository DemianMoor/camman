import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands, creatives, offers, sms_providers } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { generateCreativeSlug } from "@/lib/creative-helpers";
import { can } from "@/lib/permissions";
import {
  creativeCreateSchema,
  nullIfEmpty,
} from "@/lib/validators/creatives";

const SLUG_RETRY_LIMIT = 5;

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "creatives.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = creativeCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Verify the offer belongs to this org. The other two FKs are optional.
  const offerRow = await db
    .select({ id: offers.id })
    .from(offers)
    .where(
      and(eq(offers.id, parsed.data.offer_id), eq(offers.org_id, orgId)),
    )
    .limit(1);
  if (!offerRow[0]) {
    return apiError(
      400,
      "offer_id doesn't belong to your organization",
      API_ERROR_CODES.VALIDATION,
      { field: "offer_id" },
    );
  }
  if (parsed.data.sms_provider_id != null) {
    const r = await db
      .select({ id: sms_providers.id })
      .from(sms_providers)
      .where(
        and(
          eq(sms_providers.id, parsed.data.sms_provider_id),
          eq(sms_providers.org_id, orgId),
        ),
      )
      .limit(1);
    if (!r[0]) {
      return apiError(
        400,
        "sms_provider_id doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "sms_provider_id" },
      );
    }
  }
  if (parsed.data.brand_id != null) {
    const r = await db
      .select({ id: brands.id })
      .from(brands)
      .where(
        and(eq(brands.id, parsed.data.brand_id), eq(brands.org_id, orgId)),
      )
      .limit(1);
    if (!r[0]) {
      return apiError(
        400,
        "brand_id doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "brand_id" },
      );
    }
  }

  // Slug retry loop. With 31^6 = ~887M combinations a collision is rare,
  // but the unique constraint is the source of truth — retry on 23505.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < SLUG_RETRY_LIMIT; attempt++) {
    try {
      const slug = generateCreativeSlug();
      const [created] = await db
        .insert(creatives)
        .values({
          org_id: orgId,
          offer_id: parsed.data.offer_id,
          sms_provider_id: parsed.data.sms_provider_id ?? null,
          brand_id: parsed.data.brand_id ?? null,
          text: parsed.data.text,
          creative_id: nullIfEmpty(parsed.data.creative_id),
          slug,
          status: parsed.data.status ?? "draft",
        })
        .returning();
      return NextResponse.json(created, { status: 201 });
    } catch (err) {
      lastError = err;
      if (!isUniqueViolation(err)) throw err;
      // 23505 — could be either slug or creative_id. The creative_id one
      // we want to surface as a real 409; the slug one we just retry.
      // Distinguish by re-attempting once: if the next try also fails on
      // creative_id, it's the user's input, not ours.
    }
  }
  // We've burned our retries. Most likely creative_id is the conflict —
  // surface a 409 with the field hint.
  if (isUniqueViolation(lastError)) {
    return apiError(
      409,
      "A creative with this creative_id already exists",
      API_ERROR_CODES.DUPLICATE,
      { field: "creative_id" },
    );
  }
  throw lastError;
}
