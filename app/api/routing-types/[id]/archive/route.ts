import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { routing_types } from "@/db/schema";
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

  if (!can(role, "routing_types.archive")) {
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
    .update(routing_types)
    .set({ status: "archived", archived_at: drizzleSql`now()` })
    .where(
      and(
        eq(routing_types.id, rid),
        eq(routing_types.org_id, orgId),
        eq(routing_types.status, "active"),
      ),
    )
    .returning();

  if (updated[0]) return NextResponse.json(updated[0]);

  const existing = await db
    .select({ status: routing_types.status })
    .from(routing_types)
    .where(and(eq(routing_types.id, rid), eq(routing_types.org_id, orgId)))
    .limit(1);

  if (!existing[0]) {
    return apiError(404, "Routing type not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "routing_type",
    });
  }
  return apiError(
    409,
    "Routing type is already archived",
    API_ERROR_CODES.CONFLICT,
    { reason: "already_archived" },
  );
}
