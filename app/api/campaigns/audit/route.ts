import { NextResponse, type NextRequest } from "next/server";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { AUDIT_STATUSES, getCampaignAudit, isAuditStatus } from "@/lib/reporting/grading";

// Operator API (creative grading): every campaign in one status with its stages in
// ONE request — the daily "which campaigns have sales but no D2 / D3 yet" sweep
// without an N+1 of per-campaign calls. The token rate limit charges this call 1,
// like any other. Read-only.
export const dynamic = "force-dynamic";
// All 53 active campaigns' per-stage send + reach counts measured 568ms (2026-09-14).
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership({ route: "campaigns/audit", method: "GET" });
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "campaigns.view") || !can(auth.role, "stages.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const status = req.nextUrl.searchParams.get("status") ?? "active";
  if (!isAuditStatus(status)) {
    return apiError(
      400,
      `\`status\` must be one of: ${AUDIT_STATUSES.join(", ")}`,
      API_ERROR_CODES.VALIDATION,
      { field: "status" },
    );
  }

  return NextResponse.json(await getCampaignAudit(auth.orgId, status));
}
