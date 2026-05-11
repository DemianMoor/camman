import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { traffic_types } from "@/db/schema";
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

  if (!can(role, "traffic_types.restore")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const rid = parseId(id);
  if (rid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const updated = await db
    .update(traffic_types)
    .set({ status: "active", archived_at: null })
    .where(
      and(
        eq(traffic_types.id, rid),
        eq(traffic_types.org_id, orgId),
        eq(traffic_types.status, "archived"),
      ),
    )
    .returning();

  if (updated[0]) return NextResponse.json(updated[0]);

  const existing = await db
    .select({ status: traffic_types.status })
    .from(traffic_types)
    .where(and(eq(traffic_types.id, rid), eq(traffic_types.org_id, orgId)))
    .limit(1);

  if (!existing[0]) {
    return apiError(404, "Traffic type not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "traffic_type",
    });
  }
  return apiError(
    409,
    "Traffic type is already active",
    API_ERROR_CODES.CONFLICT,
    { reason: "already_active" },
  );
}
