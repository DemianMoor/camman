import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "brands.restore")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const brandId = parseId(id);
  if (brandId === null) {
    return apiError(400, "Invalid brand id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const updated = await db
    .update(brands)
    .set({ status: "active", archived_at: null })
    .where(
      and(
        eq(brands.id, brandId),
        eq(brands.org_id, orgId),
        eq(brands.status, "archived"),
      ),
    )
    .returning();

  if (updated[0]) return NextResponse.json(updated[0]);

  const existing = await db
    .select({ status: brands.status })
    .from(brands)
    .where(and(eq(brands.id, brandId), eq(brands.org_id, orgId)))
    .limit(1);

  if (!existing[0]) {
    return apiError(404, "Brand not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "brand",
    });
  }
  return apiError(
    409,
    "Brand is already active",
    API_ERROR_CODES.CONFLICT,
    { reason: "already_active" },
  );
}
