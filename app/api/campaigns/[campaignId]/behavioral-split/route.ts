import { NextResponse, type NextRequest } from "next/server";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import { performBehavioralSplit } from "@/lib/stages/behavioral-split";

// Behavioural split, CAMPAIGN-LEVEL (migration 0174). Stamps three lane-stages —
// one per behavioural tier (0 ignored / 1 clicked / 2 reached offer) — plus the
// `campaign_stage_split_groups` row that owns them. Tier 3 (converted) gets NO
// lane; those contacts exit the sequence.
//
// This REPLACES the old per-stage endpoint
// (`/stages/[stageId]/behavioral-split`, removed in the same change). The split
// is no longer taken against one chosen predecessor: the lanes' audience is
// every contact who received ANY COMPLETED stage of the campaign, classified by
// their campaign-wide high-water tier. `campaignTierExpr` already read the tier
// campaign-wide — only the aliveness anchor was per-stage.
//
// The source set is NOT resolved here (the group starts 'pending'): a stage that
// finishes sending between now and the T−15 recompute must be included, so
// freezing it at creation would be wrong. See lib/stages/split-group.ts.
//
// NOT gated to draft campaigns: behavioural lanes are created AFTER activation by
// design. Gated instead on ≥1 COMPLETED stage — enforced in performBehavioralSplit
// so it can be tested without an auth session; this handler is auth + error mapping.

function parseId(idParam: string): number | null {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "stages.create")) {
    return apiError(403, "Forbidden");
  }

  const { campaignId } = await params;
  const cid = parseId(campaignId);
  if (cid === null) {
    return apiError(400, "Invalid id", "validation");
  }

  const result = await performBehavioralSplit({ orgId, campaignId: cid });
  if (!result.ok) {
    return apiError(result.status, result.message, result.code, result.details);
  }

  return NextResponse.json(
    {
      split_group_id: result.split_group_id,
      anchor_stage_id: result.anchor_stage_id,
      source_stage_ids_preview: result.source_stage_ids_preview,
      lane_stage_ids: result.lane_stage_ids,
      tiers: result.tiers,
    },
    { status: 201 },
  );
}
