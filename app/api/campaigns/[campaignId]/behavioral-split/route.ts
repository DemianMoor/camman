import { NextResponse, type NextRequest } from "next/server";

import { z } from "zod";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import { LANE_TIERS, performBehavioralSplit } from "@/lib/stages/behavioral-split";

// Behavioural split, CAMPAIGN-LEVEL (migration 0174). Stamps one lane-stage per
// SELECTED behavioural tier (0 ignored / 1 clicked / 2 reached offer /
// 3 registered; 4 purchased exits) — plus the `campaign_stage_split_groups` row
// that owns them. Tier 4 gets NO lane; those contacts exit the sequence.
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

// Which lanes to create. OPTIONAL: an absent body, an empty body, or
// unparseable JSON all mean "not supplied" and fall through to
// DEFAULT_LANE_TIERS ([1, 2]) — so an older client cannot silently resurrect the
// three-lane behaviour, and a malformed body cannot 500. An explicitly INVALID
// selection (`[]`, `[5]`) is a real 400, raised by performBehavioralSplit.
const bodySchema = z.object({
  tiers: z.array(z.number().int()).max(LANE_TIERS.length).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership({
    route: "campaigns/[campaignId]/behavioral-split",
    method: "POST",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "stages.create")) {
    return apiError(403, "Forbidden");
  }

  const { campaignId } = await params;
  const cid = parseId(campaignId);
  if (cid === null) {
    return apiError(400, "Invalid id", "validation");
  }

  // No body at all / unparseable JSON ⇒ `{}` ⇒ `tiers` undefined ⇒ the default.
  // But a body that DOES carry a malformed `tiers` is a real 400 — silently
  // handing `{"tiers":["0","1","2"]}` the 2-lane default would be a wrong answer
  // dressed as a success.
  const raw: unknown = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return apiError(400, "Invalid lane selection", "invalid_lane_tier", {
      field: "tiers",
    });
  }
  const tiers = parsed.data.tiers;

  const result = await performBehavioralSplit({
    orgId,
    campaignId: cid,
    actorUserId: user.id,
    tiers,
  });
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
