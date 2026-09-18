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
import { resolveCompletedStages } from "@/lib/sends/stage-complete";
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
  const auth = await requireApiMembership({
    route: "campaigns/[campaignId]/stages/lane-counts",
    method: "GET",
  });
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
      split_group_id: campaign_stages.split_group_id,
      // 0174: the lane's group source set, so the displayed count uses the SAME
      // aliveness universe the send will. NULL for legacy lanes (→ parent_stage_id);
      // empty while the group is still 'pending' (→ the campaign-wide completed
      // set previewed below, which is what the T−15 recompute will resolve).
      source_stage_ids: drizzleSql<number[] | null>`(
        SELECT g.source_stage_ids FROM campaign_stage_split_groups g
        WHERE g.id = ${campaign_stages.split_group_id}
      )`,
    })
    .from(campaign_stages)
    .where(and(...conditions))
    .orderBy(asc(campaign_stages.stage_number));

  // ── Pending-group fallback: preview the CAMPAIGN-WIDE source set ───────────
  //
  // A 0174 group's `source_stage_ids` stays empty until it is recomputed at
  // T−15 (recomputeDueSplitGroups, gated on send_approved + scheduled_at), so a
  // freshly-created lane has none. Falling back to `parent_stage_id` there —
  // which is what alivenessKey() does when the set is empty — counts only the
  // contacts who received the ANCHOR stage, and the anchor is routinely one half
  // of an A/B split with its own creative and its own CTR. Measured on campaign
  // 1342 (2026-09-18): the confirm modal said 39 clicked / 3 reached offer over
  // all 4 completed stages, while the list showed 13 / 1 over the anchor alone.
  //
  // The SEND never uses that narrow set — kickoff resolves the group first and
  // REFUSES (`split_group_not_ready`) rather than materializing the single-parent
  // audience — so the narrow number was display-only, but it was wrong at exactly
  // the moment the operator decides whether a lane is worth sending.
  //
  // So preview what the recompute WILL resolve: the same completed-stage set,
  // from the same shared helper (lib/sends/stage-complete.ts). Computed live, so
  // it widens as further stages finish — matching both the confirm modal
  // (previewSplitLanes) and what materializes.
  //
  // Scope is deliberately narrow:
  //   • group HAS a resolved set  → use it (frozen; it is what the send used)
  //   • split_group_id IS NULL    → LEGACY pre-0174 lane. Its send really does
  //     use single-parent aliveness, so changing its count would break the
  //     agreement with stageRecipientsSql. Left untouched.
  //   • no completed stages       → keep the parent fallback (unreachable in
  //     practice: the split can't be created without one).
  const needsCompletedFallback = laneRows.some(
    (r) => r.split_group_id != null && (r.source_stage_ids ?? []).length === 0,
  );
  // One query for the whole page, not one per lane.
  const completedStageIds = needsCompletedFallback
    ? (await resolveCompletedStages(db, cid, orgId)).map((s) => Number(s.id))
    : [];

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
    sourceStageIds:
      (r.source_stage_ids ?? []).length > 0
        ? r.source_stage_ids
        : r.split_group_id != null && completedStageIds.length > 0
          ? completedStageIds
          : null,
    // Lanes are independent (2026-09-07): a contact taken by a sibling lane
    // is excluded at materialization, so the count must exclude them too.
    splitGroupId: r.split_group_id ?? null,
  }));

  const counts = await computeLaneAudienceCountsBatch(cid, orgId, items);

  // Emit a count for EVERY requested lane (0 when absent from the map), so the
  // client can reliably distinguish "computed as 0" from "not yet fetched".
  const out: Record<number, number> = {};
  for (const it of items) out[it.stageId] = counts.get(it.stageId) ?? 0;

  return NextResponse.json({ counts: out });
}
