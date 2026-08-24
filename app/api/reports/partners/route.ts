import { NextResponse, type NextRequest } from "next/server";

import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import { getPartnerReport } from "@/lib/reporting/partner-report";

// Internal partner report (Drip Phase 7). Authenticated, org-scoped, all
// partners x tags. The partner-facing view is a DIFFERENT route with its own
// token gate -- this one is never reachable without a session.
export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!DAY.test(from) || !DAY.test(to)) {
    return apiError(400, "from and to must be YYYY-MM-DD", API_ERROR_CODES.VALIDATION, {
      field: DAY.test(from) ? "to" : "from",
    });
  }
  if (from > to) {
    return apiError(400, "from must not be after to", API_ERROR_CODES.VALIDATION, { field: "from" });
  }

  return NextResponse.json(await getPartnerReport(orgId, from, to));
}
