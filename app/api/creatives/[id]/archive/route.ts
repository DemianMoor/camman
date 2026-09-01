import { and, eq, ne, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { creatives } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { interceptDeletion } from "@/lib/guardrails/deletion-requests";
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
  const auth = await requireApiMembership({
    route: "creatives/[id]/archive",
    method: "POST",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;


  const { id } = await params;
  const creativeId = parseId(id);
  if (creativeId === null) {
    return apiError(400, "Invalid creative id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }



  // ── Deletion approval queue (869et3vm1 Phase 3) ─────────────────────────
  //
  // For an operator this becomes a REQUEST, not a deletion. 202 rather than
  // 403: they MAY do this, it just needs an owner's decision first, and the
  // status code is what lets the UI say "requested" instead of "forbidden".
  {
    const diverted = await interceptDeletion({
      orgId,
      role,
      actorUserId: user.id,
      entityType: "creative",
      entityId: creativeId,
    });
    if (diverted.intercepted) return diverted.response;
  }

  if (!can(role, "creatives.archive")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  // Allow archive from any non-archived status — pending/ready/paused/draft
  // can all be archived directly. The state machine doesn't gate this since
  // archive is a separate endpoint with its own permission.

  const updated = await db
    .update(creatives)
    .set({ status: "archived", archived_at: drizzleSql`now()` })
    .where(
      and(
        eq(creatives.id, creativeId),
        eq(creatives.org_id, orgId),
        ne(creatives.status, "archived"),
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
    "Creative is already archived",
    API_ERROR_CODES.CONFLICT,
    { reason: "already_archived" },
  );
}
