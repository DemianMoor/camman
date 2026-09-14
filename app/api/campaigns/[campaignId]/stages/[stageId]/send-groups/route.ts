import { NextResponse, type NextRequest } from "next/server";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import {
  getStageSendGroups,
  SEND_GROUPS_DEFAULT,
  SEND_GROUPS_MAX,
  SEND_GROUPS_MIN,
} from "@/lib/reporting/grading";

// Operator API (creative grading): a stage's sent messages cut into equal groups by
// send order — first half vs second half of a cell — each with its sends, human
// clickers, reaches and opt-outs. Read-only, aggregate-only.
export const dynamic = "force-dynamic";

// campaigns.id and campaign_stages.id are int4: anything larger would reach
// Postgres as a 22003.
const MAX_INT4 = 2_147_483_647;

function parseId(v: string): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= MAX_INT4 ? n : null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership({
    route: "campaigns/[campaignId]/stages/[stageId]/send-groups",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "stages.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId: campaignParam, stageId: stageParam } = await params;
  const campaignId = parseId(campaignParam);
  const stageId = parseId(stageParam);
  if (campaignId == null || stageId == null) {
    return apiError(400, "Invalid campaign or stage id", API_ERROR_CODES.VALIDATION, {
      field: campaignId == null ? "campaignId" : "stageId",
    });
  }

  const groupsParam = req.nextUrl.searchParams.get("groups");
  const groups = groupsParam == null ? SEND_GROUPS_DEFAULT : Number(groupsParam);
  if (!Number.isInteger(groups) || groups < SEND_GROUPS_MIN || groups > SEND_GROUPS_MAX) {
    return apiError(
      400,
      `groups must be a whole number from ${SEND_GROUPS_MIN} to ${SEND_GROUPS_MAX}`,
      API_ERROR_CODES.VALIDATION,
      { field: "groups" },
    );
  }

  const result = await getStageSendGroups(auth.orgId, campaignId, stageId, groups);
  if (!result) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, { entity: "stage" });
  }
  return NextResponse.json(result);
}
