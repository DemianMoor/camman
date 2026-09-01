import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { brandCreateSchema, nullIfEmpty } from "@/lib/validators/brands";

// ⚠️ Brand creation NO LONGER WRITES A SHORT DOMAIN.
//
// It used to call applyBrandShortDomain, a one-row upsert that migration 0136
// broke outright (`ON CONFLICT (brand_id)` against an index 0136 had dropped ⇒
// Postgres 42P10, so creating a brand WITH a short domain 500'd). Since 0136 a
// brand may hold several domains, so a single field on the create form cannot
// express the shape at all.
//
// Domains are now managed through their own surface —
// POST /api/brands/[id]/short-domains — which adds them as `pending` and leaves
// activation as a deliberate act. There is exactly ONE write path; this route is
// not a second one.

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership({
    route: "brands",
    method: "POST",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "brands.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = brandCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  try {
    const created = await db.transaction(async (tx) => {
      const [b] = await tx
        .insert(brands)
        .values({
          org_id: orgId,
          name: parsed.data.name,
          brand_id: parsed.data.brand_id,
          short_link_base: nullIfEmpty(parsed.data.short_link_base),
          website: nullIfEmpty(parsed.data.website),
          avatar_url: nullIfEmpty(parsed.data.avatar_url),
          color: nullIfEmpty(parsed.data.color),
          status: "active",
        })
        .returning();

      // A new brand starts with no short domain. Add one from the brand's
      // Short domains section afterwards; it lands `pending` until activated.
      return { ...b, short_domain: null };
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "A brand with this brand_id already exists",
        API_ERROR_CODES.DUPLICATE,
        { field: "brand_id" },
      );
    }
    throw err;
  }
}
