import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { makeDefaultFormat } from "@/lib/messages/format-admin";

// One transaction: the old default is cleared and the new one set together, so
// the org is never without a default (new stages read it via the 0216 trigger).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiMembership({ route: "message-formats/[id]/make-default", method: "POST" });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "message_formats.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }
  const r = await db.transaction((tx) => makeDefaultFormat(tx, orgId, id));
  if (!r.ok) {
    const code = r.error.status === 404 ? API_ERROR_CODES.NOT_FOUND : API_ERROR_CODES.CONFLICT;
    return apiError(r.error.status, r.error.message, code, { reason: r.error.reason });
  }
  return NextResponse.json(r.row);
}
