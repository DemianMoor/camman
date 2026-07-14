import { NextResponse } from "next/server";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { getLookupGroupStats } from "@/lib/telnyx/lookup-stats";

export const dynamic = "force-dynamic";
// Reads the cache (instant). Only the first-ever load computes (~2.5s full scan).
export const maxDuration = 60;

// Lookup Stats Panel data: per-Contact-Group coverage + landline suppression, plus a
// distinct-contact summary. Cached; the response carries `computed_at` (staleness is
// shown in the UI, refreshed manually). Permission: manager+.
export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "lookup.admin")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const stats = await getLookupGroupStats(auth.orgId);
  return NextResponse.json(stats);
}
