import { and, asc, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaign_stages, campaigns } from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import {
  computeLaneAudienceCountsBatch,
  type LaneCountBatchItem,
} from "@/lib/audience-snapshot";
import { can } from "@/lib/permissions";
import { STAGE_STATUSES } from "@/lib/validators/campaign-stages";

// Behavioral-lane audience counts, split out of the main stages list so the
// table can paint immediately and fill these LIVE numbers in afterward. A
// behavioral split has 3 lanes and each lane's count is a ~seconds-long live
// tier scan (links⋈clicks + stage_sends); computeLaneAudienceCountsBatch does
// all of a campaign's lanes in ONE query (tier map computed once). Give it the
// same headroom the main list has so it degrades to "slow", not a hard timeout.
export const maxDuration = 30;

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const VALID_STAGE_STATUSES = new Set<string>(STAGE_STATUSES);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "stages.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId } = await params;
  const cid = parseId(campaignId);
  if (cid === null) {
    return apiError(400, "Invalid campaign id", API_ERROR_CODES.VALIDATION, {
      field: "campaignId",
    });
  }

  // Ownership check — the batch itself filters by org_id, but a 404 for a
  // missing/foreign campaign matches the main list's contract.
  const campaignRow = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.id, cid), eq(campaigns.org_id, orgId)))
    .limit(1);
  if (!campaignRow[0]) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "campaign",
    });
  }

  // Mirror the main list's visibility filter so we count exactly the lanes the
  // client is rendering (same status / showArchived semantics).
  const listParams = parseListParams(req);
  const sp = req.nextUrl.searchParams;
  const statusFilterRaw = sp.get("status");
  const statusFilter = statusFilterRaw
    ? statusFilterRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => VALID_STAGE_STATUSES.has(s))
    : [];

  const conditions = [
    eq(campaign_stages.campaign_id, cid),
    eq(campaign_stages.org_id, orgId),
    drizzleSql`${campaign_stages.behavioral_tier} is not null`,
  ];
  if (!listParams.showArchived && statusFilter.length === 0) {
    conditions.push(drizzleSql`${campaign_stages.status} <> 'archived'`);
  }
  if (statusFilter.length > 0) {
    conditions.push(inArray(campaign_stages.status, statusFilter));
  }

  const laneRows = await db
    .select({
      id: campaign_stages.id,
      behavioral_tier: campaign_stages.behavioral_tier,
      parent_stage_id: campaign_stages.parent_stage_id,
      include_no_status: campaign_stages.include_no_status,
      include_clickers: campaign_stages.include_clickers,
      exclude_clickers: campaign_stages.exclude_clickers,
      split_index: campaign_stages.split_index,
      split_total: campaign_stages.split_total,
    })
    .from(campaign_stages)
    .where(and(...conditions))
    .orderBy(asc(campaign_stages.stage_number));

  const items: LaneCountBatchItem[] = laneRows.map((r) => ({
    stageId: r.id,
    // behavioral_tier is guaranteed non-null by the where clause above.
    behavioralTier: r.behavioral_tier as number,
    parentStageId: r.parent_stage_id,
    include_no_status: r.include_no_status,
    include_clickers: r.include_clickers,
    exclude_clickers: r.exclude_clickers,
    split_index: r.split_index,
    split_total: r.split_total,
  }));

  const counts = await computeLaneAudienceCountsBatch(cid, orgId, items);

  // Emit a count for EVERY requested lane (0 when absent from the map), so the
  // client can reliably distinguish "computed as 0" from "not yet fetched".
  const out: Record<number, number> = {};
  for (const it of items) out[it.stageId] = counts.get(it.stageId) ?? 0;

  return NextResponse.json({ counts: out });
}
