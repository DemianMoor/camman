import { and, eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { segments } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { previewAudience } from "@/lib/audience-snapshot";
import { can } from "@/lib/permissions";
import { audiencePreviewSchema } from "@/lib/validators/campaigns";

// Live count of contacts that would be in the audience pool given a set of
// segments and a filter snapshot. Writes nothing. The campaign creation
// dialog calls this whenever filters change so the operator sees the
// impact before clicking "Launch".
export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = audiencePreviewSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const segmentIds = Array.from(new Set(parsed.data.audience_segment_ids));

  const found = await db
    .select({ id: segments.id })
    .from(segments)
    .where(and(eq(segments.org_id, orgId), inArray(segments.id, segmentIds)));
  if (found.length !== segmentIds.length) {
    return apiError(
      400,
      "One or more audience_segment_ids don't belong to your organization",
      API_ERROR_CODES.VALIDATION,
      { field: "audience_segment_ids" },
    );
  }

  const result = await previewAudience({
    orgId,
    segmentIds,
    filters: parsed.data.audience_filters ?? {},
  });
  return NextResponse.json(result);
}
