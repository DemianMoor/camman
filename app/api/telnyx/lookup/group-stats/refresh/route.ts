import { NextResponse } from "next/server";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { refreshLookupGroupStats } from "@/lib/telnyx/lookup-stats";

export const dynamic = "force-dynamic";
// Forces a recompute (~2.5s full-population scan).
export const maxDuration = 60;

// Manual "Refresh now". Recomputes and atomically overwrites the cache. If the
// recompute throws (query error or a broken reconciliation invariant), the compute
// runs BEFORE the write, so the prior cache row is left intact — we return 500 with
// the reason and the UI keeps serving the older cached data. Permission: manager+.
export async function POST() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "lookup.admin")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  try {
    const stats = await refreshLookupGroupStats(auth.orgId);
    return NextResponse.json(stats);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[lookup-group-stats] refresh failed (prior cache preserved):", err);
    return apiError(
      500,
      `Refresh failed — showing the last good data. ${message}`,
      API_ERROR_CODES.INTERNAL,
    );
  }
}
