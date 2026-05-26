import { and, desc, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  campaign_stages,
  campaigns,
  stage_results_imports,
} from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Import history for a stage. Ordered newest-first. Includes both active
// and reverted imports — the UI filters/styles based on reverted_at.
export async function GET(
  _req: NextRequest,
  {
    params,
  }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "result_imports.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId, stageId } = await params;
  const cid = parseId(campaignId);
  const sid = parseId(stageId);
  if (cid === null || sid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  const stageRow = await db
    .select({ id: campaign_stages.id })
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
  if (!stageRow[0]) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "stage",
    });
  }

  const rows = await db
    .select({
      id: stage_results_imports.id,
      filename: stage_results_imports.filename,
      submitted_rows: stage_results_imports.submitted_rows,
      processed_rows: stage_results_imports.processed_rows,
      delivered_added: stage_results_imports.delivered_added,
      failed_added: stage_results_imports.failed_added,
      optouts_added: stage_results_imports.optouts_added,
      clickers_added: stage_results_imports.clickers_added,
      scrubbed_added: stage_results_imports.scrubbed_added,
      bounced_added: stage_results_imports.bounced_added,
      total_cost_added: stage_results_imports.total_cost_added,
      mapping_id: stage_results_imports.mapping_id,
      imported_by_user_id: stage_results_imports.imported_by_user_id,
      reverted_at: stage_results_imports.reverted_at,
      reverted_by_user_id: stage_results_imports.reverted_by_user_id,
      created_at: stage_results_imports.created_at,
    })
    .from(stage_results_imports)
    .where(
      and(
        eq(stage_results_imports.stage_id, sid),
        eq(stage_results_imports.org_id, orgId),
      ),
    )
    .orderBy(desc(stage_results_imports.created_at));

  return NextResponse.json({ data: rows, totalCount: rows.length });
}
