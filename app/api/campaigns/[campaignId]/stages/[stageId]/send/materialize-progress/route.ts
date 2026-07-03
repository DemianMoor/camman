import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

// Lightweight read-only materialization progress for the Prepare UI: how many
// stage_sends rows exist for this stage yet, and whether materialization is
// complete (campaign_stages.materialized_at set). The Prepare dialog polls this
// while the (long) approve-send call runs so the operator sees a live count
// instead of a frozen button. Read-only — never triggers materialization.
function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId: cIdParam, stageId: sIdParam } = await params;
  const campaignId = parseId(cIdParam);
  const stageId = parseId(sIdParam);
  if (campaignId === null || stageId === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  const rows = (await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM stage_sends ss
        WHERE ss.stage_id = ${stageId} AND ss.org_id = ${orgId}) AS materialized,
      (s.materialized_at IS NOT NULL) AS complete
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    WHERE s.id = ${stageId} AND s.campaign_id = ${campaignId} AND c.org_id = ${orgId}
    LIMIT 1
  `)) as unknown as { materialized: number; complete: boolean }[];

  if (!rows[0]) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, { entity: "stage" });
  }

  return NextResponse.json({
    materialized: Number(rows[0].materialized),
    complete: rows[0].complete === true,
  });
}
