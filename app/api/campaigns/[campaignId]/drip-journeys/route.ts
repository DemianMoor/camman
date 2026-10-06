import { NextResponse, type NextRequest } from "next/server";

import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { getDripFunnel } from "@/lib/drip/funnel";
import { can } from "@/lib/permissions";

// The journey funnel for one drip campaign (Drip Phase 7). The per-journey list
// this route used to return (latest 50, raw routing JSON) was replaced by the
// CSV export at ./export.
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const { campaignId: raw } = await params;
  const cid = Number(raw);
  if (!Number.isInteger(cid) || cid <= 0) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  const funnel = await getDripFunnel(orgId, cid);
  return NextResponse.json({ funnel });
}
