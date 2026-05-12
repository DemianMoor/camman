import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "contacts.archive")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return apiError(400, "Invalid contact id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  // Idempotent: re-archiving an archived contact is a no-op, returns 200.
  const updated = await db
    .update(contacts)
    .set({
      is_archived: true,
      archived_at: drizzleSql`now()`,
      updated_at: drizzleSql`now()`,
    })
    .where(and(eq(contacts.id, id), eq(contacts.org_id, orgId)))
    .returning();

  if (!updated[0]) {
    return apiError(404, "Contact not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "contact",
    });
  }
  return NextResponse.json(updated[0]);
}
