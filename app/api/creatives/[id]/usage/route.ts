import { NextResponse, type NextRequest } from "next/server";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { getCreativeUsage } from "@/lib/reporting/grading";

// Operator API (creative grading): every campaign + sending number + ET day this
// creative has already run on, so a creative manager can enforce cohort freshness
// and the one-text-one-number-per-day rule from aggregates alone. Read-only.
export const dynamic = "force-dynamic";
// The most-reused creative (80 sent stages) measured 5.3s (2026-09-14).
export const maxDuration = 60;

// creatives.id is an int4: anything larger would reach Postgres as a 22003.
const MAX_INT4 = 2_147_483_647;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership({ route: "creatives/[id]/usage", method: "GET" });
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "creatives.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
  const creativeId = Number(id);
  if (!Number.isInteger(creativeId) || creativeId <= 0 || creativeId > MAX_INT4) {
    return apiError(400, "Invalid creative id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }

  const usage = await getCreativeUsage(auth.orgId, creativeId);
  if (!usage) {
    return apiError(404, "Creative not found", API_ERROR_CODES.NOT_FOUND, { entity: "creative" });
  }
  return NextResponse.json(usage);
}
