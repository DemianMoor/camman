import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { sms_providers } from "@/db/schema";
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
  { params }: { params: Promise<{ providerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "providers.restore")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { providerId } = await params;
  const id = parseId(providerId);
  if (id === null) {
    return apiError(400, "Invalid provider id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const updated = await db
    .update(sms_providers)
    .set({ status: "active", archived_at: null })
    .where(
      and(
        eq(sms_providers.id, id),
        eq(sms_providers.org_id, orgId),
        eq(sms_providers.status, "archived"),
      ),
    )
    .returning();

  if (updated[0]) return NextResponse.json(updated[0]);

  const existing = await db
    .select({ status: sms_providers.status })
    .from(sms_providers)
    .where(and(eq(sms_providers.id, id), eq(sms_providers.org_id, orgId)))
    .limit(1);

  if (!existing[0]) {
    return apiError(404, "Provider not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider",
    });
  }
  return apiError(
    409,
    "Provider is already active",
    API_ERROR_CODES.CONFLICT,
    { reason: "already_active" },
  );
}
