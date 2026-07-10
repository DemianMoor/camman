import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { previewLookup } from "@/lib/telnyx/preview";

export const maxDuration = 60;

const schema = z.object({ phones: z.string().min(1) });

// Review-panel preview for a new-contact upload with the lookup toggle ON.
// Read-only + a Telnyx balance call; inserts/enqueues nothing. Permission: operator+.
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
  return NextResponse.json(await previewLookup(lines));
}
