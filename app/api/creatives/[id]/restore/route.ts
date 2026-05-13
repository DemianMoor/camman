import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { creatives } from "@/db/schema";
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

  if (!can(role, "creatives.restore")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const creativeId = parseId(id);
  if (creativeId === null) {
    return apiError(400, "Invalid creative id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  // Restore returns the creative to active. No state machine anymore.
  const updated = await db
    .update(creatives)
    .set({ status: "active", archived_at: null })
    .where(
      and(
        eq(creatives.id, creativeId),
        eq(creatives.org_id, orgId),
        eq(creatives.status, "archived"),
      ),
    )
    .returning();

  if (updated[0]) return NextResponse.json(updated[0]);

  const existing = await db
    .select({ status: creatives.status })
    .from(creatives)
    .where(and(eq(creatives.id, creativeId), eq(creatives.org_id, orgId)))
    .limit(1);
  if (!existing[0]) {
    return apiError(404, "Creative not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "creative",
    });
  }
  return apiError(
    409,
    "Creative is not archived",
    API_ERROR_CODES.CONFLICT,
    { reason: "not_archived" },
  );
}
