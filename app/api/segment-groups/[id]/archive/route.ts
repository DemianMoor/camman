import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { segment_groups } from "@/db/schema";
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

  if (!can(role, "segment_groups.archive")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const sid = parseId(id);
  if (sid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const updated = await db
    .update(segment_groups)
    .set({ status: "archived", archived_at: drizzleSql`now()` })
    .where(
      and(
        eq(segment_groups.id, sid),
        eq(segment_groups.org_id, orgId),
        eq(segment_groups.status, "active"),
      ),
    )
    .returning();

  if (updated[0]) return NextResponse.json(updated[0]);

  const existing = await db
    .select({ status: segment_groups.status })
    .from(segment_groups)
    .where(and(eq(segment_groups.id, sid), eq(segment_groups.org_id, orgId)))
    .limit(1);

  if (!existing[0]) {
    return apiError(404, "Segment group not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "segment_group",
    });
  }
  return apiError(
    409,
    "Segment group is already archived",
    API_ERROR_CODES.CONFLICT,
    { reason: "already_archived" },
  );
}
