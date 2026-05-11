import { and, eq, ne, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { provider_phones } from "@/db/schema";
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
  { params }: { params: Promise<{ providerId: string; phoneId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "provider_phones.archive")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { providerId, phoneId } = await params;
  const pid = parseId(providerId);
  const phid = parseId(phoneId);
  if (pid === null || phid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  // Archive from any non-archived state.
  const updated = await db
    .update(provider_phones)
    .set({ status: "archived", archived_at: drizzleSql`now()` })
    .where(
      and(
        eq(provider_phones.id, phid),
        eq(provider_phones.provider_id, pid),
        eq(provider_phones.org_id, orgId),
        ne(provider_phones.status, "archived"),
      ),
    )
    .returning();

  if (updated[0]) return NextResponse.json(updated[0]);

  const existing = await db
    .select({ status: provider_phones.status })
    .from(provider_phones)
    .where(
      and(
        eq(provider_phones.id, phid),
        eq(provider_phones.provider_id, pid),
        eq(provider_phones.org_id, orgId),
      ),
    )
    .limit(1);

  if (!existing[0]) {
    return apiError(404, "Phone not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider_phone",
    });
  }
  return apiError(
    409,
    "Phone is already archived",
    API_ERROR_CODES.CONFLICT,
    { reason: "already_archived" },
  );
}
