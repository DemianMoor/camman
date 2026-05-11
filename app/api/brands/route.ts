import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import { brandCreateSchema, nullIfEmpty } from "@/lib/validators/brands";

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "brands.create")) {
    return apiError(403, "forbidden", "forbidden");
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "invalid_json", "invalid_json");
  }

  const parsed = brandCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "validation_failed",
      "validation_failed",
    );
  }

  try {
    const [created] = await db
      .insert(brands)
      .values({
        org_id: orgId,
        name: parsed.data.name,
        brand_id: parsed.data.brand_id,
        short_link_base: nullIfEmpty(parsed.data.short_link_base),
        avatar_url: nullIfEmpty(parsed.data.avatar_url),
        color: nullIfEmpty(parsed.data.color),
        status: "active",
      })
      .returning();
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "A brand with this brand_id already exists",
        "duplicate_brand_id",
      );
    }
    throw err;
  }
}
