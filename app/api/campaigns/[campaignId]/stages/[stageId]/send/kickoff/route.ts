import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { logCampaignEvent } from "@/lib/campaign-events";
import { kickoffStageSend, type KickoffRefusal } from "@/lib/sends/kickoff";
import { can } from "@/lib/permissions";

export const maxDuration = 60;

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Specific, operator-readable reason per refusal (no generic error).
const REFUSAL: Record<KickoffRefusal, { status: number; message: string }> = {
  not_found: { status: 404, message: "Campaign or stage not found" },
  no_creative: { status: 400, message: "Add a creative to this stage before sending" },
  already_pending: {
    status: 409,
    message: "This stage already has a pending send batch — resolve it before starting another",
  },
  no_recipients: { status: 400, message: "No recipients qualify for this stage" },
  stage_not_ready: {
    status: 400,
    message: "Stage isn't ready to send — it's missing its tracking ID",
  },
  no_provider: { status: 400, message: "Assign an SMS provider to this stage first" },
  provider_not_api_capable: {
    status: 400,
    message: "The stage's SMS provider isn't enabled for API sending",
  },
  no_credentials: {
    status: 400,
    message: "The stage's SMS provider has no API credentials configured",
  },
  no_short_domain: {
    status: 400,
    message: "Add an active short domain for this brand before sending tracked links",
  },
  no_destination: {
    status: 400,
    message: "The tracked link has no destination — set a sales page (and tracking) on the stage",
  },
};

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
