import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaign_stages, campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { computeStageAudienceCount } from "@/lib/audience-snapshot";
import { can } from "@/lib/permissions";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Audience count + breakdown for an EXISTING saved stage, computed against
// its stored filter toggles. Mirrors the POST audience-preview endpoint but
// reads filters from the stage row rather than the request body — useful
// for the export-enable check and for refreshing counts in the stages list.
export async function GET(
  _req: NextRequest,
  {
    params,
  }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "stages.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId, stageId } = await params;
  const cid = parseId(campaignId);
  const sid = parseId(stageId);
  if (cid === null || sid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  const rows = await db
    .select({
      include_no_status: campaign_stages.include_no_status,
      include_clickers: campaign_stages.include_clickers,
      exclude_clickers: campaign_stages.exclude_clickers,
      pool_size: campaigns.audience_snapshot_count,
    })
    .from(campaign_stages)
    .innerJoin(campaigns, eq(campaigns.id, campaign_stages.campaign_id))
    .where(
      and(
        eq(campaign_stages.id, sid),
        eq(campaign_stages.campaign_id, cid),
        eq(campaign_stages.org_id, orgId),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "stage",
    });
  }
  const stage = rows[0];

  const result = await computeStageAudienceCount(cid, orgId, {
    include_no_status: stage.include_no_status,
    include_clickers: stage.include_clickers,
    exclude_clickers: stage.exclude_clickers,
  });

  return NextResponse.json({
    count: result.count,
    breakdown: result.breakdown,
    pool_size: stage.pool_size,
  });
}
