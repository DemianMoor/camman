import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { softDeleteContacts } from "@/lib/contacts/blocks";
import { can } from "@/lib/permissions";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "contacts.archive")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return apiError(400, "Invalid contact id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  // Soft delete through lib/contacts/blocks.ts — the only writer of archived_at, so
  // the ledger invariant holds (an archived contact always has an active
  // contact_blocks row; spec D2/A1). Idempotent: a no-op returns the row.
  const updated = await db.transaction(async (tx) => {
    await softDeleteContacts(tx, { orgId, contactIds: [id], actorId: user.id });
    return tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.org_id, orgId)))
      .limit(1);
  });

  if (!updated[0]) {
    return apiError(404, "Contact not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "contact",
    });
  }
  return NextResponse.json(updated[0]);
}
