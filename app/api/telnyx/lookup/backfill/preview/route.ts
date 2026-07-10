import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { previewBackfill } from "@/lib/telnyx/backfill";

export const maxDuration = 60;

const schema = z.object({
  sampleLimit: z.number().int().positive().max(10_000_000).nullable().optional(),
});

// Preview a lookup backfill: distinct non-archived phones needing a lookup, contact
// count, archived-excluded, estimated cost, live balance, daily-cap ETA. Read-only.
// Permission: manager+ (lookup.admin).
export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "lookup.admin")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  let json: unknown = {};
  try {
    json = await req.json();
  } catch {
    /* empty body is fine */
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return apiError(400, parsed.error.issues[0]?.message ?? "Invalid input", API_ERROR_CODES.VALIDATION);
  }
  return NextResponse.json(await previewBackfill(auth.orgId, parsed.data.sampleLimit ?? null));
}
