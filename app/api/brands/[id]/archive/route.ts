import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
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

  if (!can(role, "brands.archive")) {
    return apiError(403, "forbidden", "forbidden");
  }

  const { id } = await params;
  const brandId = parseId(id);
  if (brandId === null) return apiError(400, "invalid_id", "invalid_id");

  const updated = await db
    .update(brands)
    .set({ status: "archived", archived_at: drizzleSql`now()` })
    .where(
      and(
        eq(brands.id, brandId),
        eq(brands.org_id, orgId),
        eq(brands.status, "active"),
      ),
    )
    .returning();

  if (updated[0]) return NextResponse.json(updated[0]);

  // Either the brand doesn't exist (in this org) or it was already archived.
  const existing = await db
    .select({ status: brands.status })
    .from(brands)
    .where(and(eq(brands.id, brandId), eq(brands.org_id, orgId)))
    .limit(1);

  if (!existing[0]) return apiError(404, "brand_not_found", "brand_not_found");
  return apiError(409, "brand_already_archived", "brand_already_archived");
}
