import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { createFormat } from "@/lib/messages/format-admin";
import { messageFormatCreateSchema } from "@/lib/validators/message-formats";

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership({ route: "message-formats", method: "POST" });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "message_formats.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = messageFormatCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION);
  }
  const r = await createFormat(db, orgId, parsed.data);
  if (!r.ok) {
    return apiError(r.error.status, r.error.message, API_ERROR_CODES.VALIDATION, { reason: r.error.reason, ...r.error.details });
  }
  return NextResponse.json(r.row, { status: 201 });
}
