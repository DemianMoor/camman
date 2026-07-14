import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { previewGroupLookup } from "@/lib/telnyx/preview";

// Group scan can be heavy at scale (distinct-phone anti-join over a large group).
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const schema = z.object({ groupId: z.coerce.number().int().positive() });

// Read-only preview for "Look up this group": remaining un-looked-up numbers, how
// many would actually enqueue, provisional cost, live balance, days-to-drain at the
// shared daily cap. Enqueues nothing. Permission: manager+ (lookup.admin).
export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "lookup.admin")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const parsed = schema.safeParse({
    groupId: req.nextUrl.searchParams.get("groupId"),
  });
  if (!parsed.success) {
    return apiError(400, "groupId (positive integer) required", API_ERROR_CODES.VALIDATION);
  }
  return NextResponse.json(await previewGroupLookup(auth.orgId, parsed.data.groupId));
}
