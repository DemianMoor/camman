import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { enqueueGroup } from "@/lib/telnyx/enqueue";

// Set-based INSERT..SELECT over the group; heavier than a small upload at scale.
export const maxDuration = 60;

const schema = z.object({ groupId: z.number().int().positive() });

// Enqueue a contact group's remaining un-looked-up numbers into the existing
// lookup queue (trigger='upload', dedup vs cache-complete + already-pending). The
// existing worker drains it under the existing daily cap / lease / balance gate —
// no new pipeline. Never runs inline. Permission: manager+ (lookup.admin).
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
    return apiError(400, "groupId (positive integer) required", API_ERROR_CODES.VALIDATION);
  }
  return NextResponse.json(await enqueueGroup(auth.orgId, parsed.data.groupId, "upload"));
}
