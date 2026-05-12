import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { utm_tags } from "@/db/schema";
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

  if (!can(role, "utm_tags.archive")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const tid = parseId(id);
  if (tid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const updated = await db
    .update(utm_tags)
    .set({ status: "archived", archived_at: drizzleSql`now()` })
    .where(
      and(
        eq(utm_tags.id, tid),
        eq(utm_tags.org_id, orgId),
        eq(utm_tags.status, "active"),
      ),
    )
    .returning();

  if (updated[0]) return NextResponse.json(updated[0]);

  const existing = await db
    .select({ status: utm_tags.status })
    .from(utm_tags)
    .where(and(eq(utm_tags.id, tid), eq(utm_tags.org_id, orgId)))
    .limit(1);

  if (!existing[0]) {
    return apiError(404, "UTM tag not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "utm_tag",
    });
  }
  return apiError(
    409,
    "UTM tag is already archived",
    API_ERROR_CODES.CONFLICT,
    { reason: "already_archived" },
  );
}
