import { NextResponse, type NextRequest } from "next/server";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import { performBehavioralSplit } from "@/lib/stages/behavioral-split";

// Behavioral split: turn ONE chosen stage into a PARENT position and stamp out
// three lane-stages under it, one per behavioral tier (0 ignored / 1 clicked /
// 2 reached offer). Tier 3 (converted) gets NO lane — those contacts exit.
//
// Unlike the A/B split (which repurposes the source as split 1/N), the chosen
// stage stays an ORDINARY stage — it's the position the lanes hang off via
// parent_stage_id. Lanes draw their audience LIVE at send time off the
// campaign-wide high-water tier (lib/sends/recipients.ts), not off the parent's
// recipient list; parent_stage_id is only the aliveness anchor.
//
// NOT gated to draft campaigns: behavioral lanes are created AFTER activation by
// design — and the A/B split route has no campaign-status gate to copy either.
// The transaction/clone/guards live in performBehavioralSplit so they can be
// tested without the auth session; this handler is auth + error mapping only.

function parseId(idParam: string): number | null {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "stages.create")) {
    return apiError(403, "Forbidden");
  }

  const { campaignId, stageId } = await params;
  const cid = parseId(campaignId);
  const sid = parseId(stageId);
  if (cid === null || sid === null) {
    return apiError(400, "Invalid id", "validation");
  }

  const result = await performBehavioralSplit({
    orgId,
    campaignId: cid,
    stageId: sid,
  });
  if (!result.ok) {
    return apiError(result.status, result.message, result.code, result.details);
  }

  return NextResponse.json(
    {
      parent_stage_id: result.parent_stage_id,
      lane_stage_ids: result.lane_stage_ids,
      tiers: result.tiers,
    },
    { status: 201 },
  );
}
