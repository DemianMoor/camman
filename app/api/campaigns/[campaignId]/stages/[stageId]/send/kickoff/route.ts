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

  // Windowed + resumable: kickoffStageSend commits per window and manages its own
  // transactions, so it must NOT be wrapped in an outer transaction. It returns
  // complete=false when the time budget was hit mid-materialization — the
  // scheduled-send cron then resumes the remainder before the send window opens.
  const result = await kickoffStageSend(db, { orgId, campaignId, stageId });
  if (result.ok) {
    await logCampaignEvent(db, {
      orgId,
      campaignId,
      stageId,
      actorUserId: user.id,
      eventType: "send_kickoff",
      summary: result.complete
        ? `Send batch materialized: ${result.materialized.toLocaleString()} recipient${result.materialized === 1 ? "" : "s"} (${result.mode})`
        : `Materializing send batch in the background: ${result.materialized.toLocaleString()} so far (${result.mode})`,
      metadata: {
        materialized: result.materialized,
        complete: result.complete,
        mode: result.mode,
      },
    });
  }

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
