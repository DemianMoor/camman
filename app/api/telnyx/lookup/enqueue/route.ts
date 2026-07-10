import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { enqueueLookups } from "@/lib/telnyx/enqueue";

export const maxDuration = 60;

const schema = z.object({ phones: z.string().min(1) });

// Enqueue a set of uploaded numbers for lookup (trigger='upload'). Called by the
// upload UI AFTER contacts insert when the lookup toggle is ON — decoupled from the
// per-entity upload routes so one endpoint covers every phone-upload path. Dedups
// against cache-complete + already-pending. Permission: operator+.
export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "lookup.run")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION);
  }
  const lines = parsed.data.phones.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  return NextResponse.json(await enqueueLookups(auth.orgId, lines, "upload"));
}
