import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { updateFormat, type FormatAdminError } from "@/lib/messages/format-admin";
import { messageFormatUpdateSchema } from "@/lib/validators/message-formats";

const CODE: Record<FormatAdminError["status"], string> = {
  400: API_ERROR_CODES.VALIDATION,
  404: API_ERROR_CODES.NOT_FOUND,
  409: API_ERROR_CODES.CONFLICT,
};

// Edit name / template, enable / disable. Disabling a format live stages use is
// refused with their count (409 format_in_use) — never a silent fallback.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApiMembership({ route: "message-formats/[id]", method: "PATCH" });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "message_formats.manage")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = messageFormatUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION);
  }
  const r = await updateFormat(db, orgId, id, parsed.data);
  if (!r.ok) {
    return apiError(r.error.status, r.error.message, CODE[r.error.status], { reason: r.error.reason, ...r.error.details });
  }
  return NextResponse.json(r.row);
}
