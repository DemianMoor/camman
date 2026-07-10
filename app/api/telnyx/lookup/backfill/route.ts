import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { runBackfill } from "@/lib/telnyx/backfill";

export const maxDuration = 60;

const schema = z.object({
  sampleLimit: z.number().int().positive().max(10_000_000).nullable().optional(),
  confirm: z.literal(true),
});

// Kick a lookup backfill batch over the org's non-archived phones lacking a lookup.
// An optional sampleLimit RANDOMLY samples that many (the 500-number calibration run
// uses sampleLimit=500 through this exact path — no separate script). Requires
// confirm:true. Permission: manager+ (lookup.admin).
export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "lookup.admin")) {
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
    return apiError(400, parsed.error.issues[0]?.message ?? "confirm:true required", API_ERROR_CODES.VALIDATION);
  }
  return NextResponse.json(await runBackfill(auth.orgId, parsed.data.sampleLimit ?? null));
}
