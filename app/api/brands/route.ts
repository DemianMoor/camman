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
import { applyBrandShortDomain } from "@/lib/sends/short-domain";
import { brandCreateSchema, nullIfEmpty } from "@/lib/validators/brands";

// Thrown inside the brand transaction to surface a specific short-domain
// failure as the right HTTP error after rollback.
class ShortDomainError extends Error {
  constructor(
    public status: number,
    public reason: string,
    message: string,
  ) {
    super(message);
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
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

      const r = await applyBrandShortDomain(tx, {
        orgId,
        brandId: b.id,
        rawDomain: parsed.data.short_domain,
      });
      if (!r.ok) {
        throw new ShortDomainError(
          r.reason === "invalid_domain" ? 400 : 409,
          r.reason,
          r.message,
        );
      }
      return { ...b, short_domain: r.domain };
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (err instanceof ShortDomainError) {
      return apiError(
        err.status,
        err.message,
        err.status === 409 ? API_ERROR_CODES.CONFLICT : API_ERROR_CODES.VALIDATION,
        { reason: err.reason },
      );
    }
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
