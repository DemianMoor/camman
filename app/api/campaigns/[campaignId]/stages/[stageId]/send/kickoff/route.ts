import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { logCampaignEvent } from "@/lib/campaign-events";
import { kickoffStageSend } from "@/lib/sends/kickoff";
import { KICKOFF_REFUSAL as REFUSAL } from "@/lib/sends/kickoff-refusals";
import { can } from "@/lib/permissions";

// Materialization is O(recipients) index-maintenance work (measured ~3.5ms/
// recipient: enumerate + mint links + insert stage_sends across heavily-indexed
// tables). At 60s a stage timed out around ~17K recipients and rolled the whole
// batch back. 300s (Vercel Pro ceiling) is the guardrail; the windowed,
// per-window-commit materialization below (kickoffStageSend) is the real fix —
// it commits progress incrementally and resumes, so a timeout no longer loses work.
export const maxDuration = 300;

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Materialize a stage's send batch (stage_sends rows) and, in tracked mode,
// mint one link per recipient. Does NOT send — the (owner-gated) drain does.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "campaigns.activate")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId: cIdParam, stageId: sIdParam } = await params;
  const campaignId = parseId(cIdParam);
  const stageId = parseId(sIdParam);
  if (campaignId === null || stageId === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  const result = await db.transaction(async (tx) => {
    const r = await kickoffStageSend(tx, { orgId, campaignId, stageId });
    if (r.ok) {
      await logCampaignEvent(tx, {
        orgId,
        campaignId,
        stageId,
        actorUserId: user.id,
        eventType: "send_kickoff",
        summary: `Send batch materialized: ${r.materialized.toLocaleString()} recipient${r.materialized === 1 ? "" : "s"} (${r.mode})`,
        metadata: { materialized: r.materialized, mode: r.mode },
      });
    }
    return r;
  });

  if (!result.ok) {
    const r = REFUSAL[result.reason];
    return apiError(
      r.status,
      r.message,
      r.status === 404 ? API_ERROR_CODES.NOT_FOUND : API_ERROR_CODES.VALIDATION,
      { reason: result.reason },
    );
  }

  return NextResponse.json(result);
}
