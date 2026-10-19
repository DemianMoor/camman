import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { listFormats } from "@/lib/messages/format-admin";

// Every role may list (operators pick a format on a stage). Default first.
export async function GET() {
  const auth = await requireApiMembership({ route: "message-formats/list", method: "GET" });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "message_formats.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  return NextResponse.json({ data: await listFormats(db, orgId) });
}
