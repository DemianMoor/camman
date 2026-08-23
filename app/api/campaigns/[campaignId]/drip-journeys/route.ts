import { sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";

// Recent journeys for one drip campaign (Drip Phase 4).
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

  const data = await db.execute(drizzleSql`
    SELECT j.id, j.state, j.routed_at, j.campaign_id, j.reason, c.phone_number
    FROM drip_journeys j
    JOIN contacts c ON c.id = j.contact_id
    WHERE j.org_id = ${orgId}::uuid AND j.campaign_id = ${cid}
    ORDER BY j.routed_at DESC
    LIMIT 50
  `);
  return NextResponse.json({ data });
}
