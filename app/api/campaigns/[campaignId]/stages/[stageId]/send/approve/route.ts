import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaign_stages } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { isStageNumberBrandStale } from "@/lib/api/campaign-brand-change";
import { logCampaignEvent } from "@/lib/campaign-events";
import { can } from "@/lib/permissions";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Toggle a stage's send_approved gate. Deliberate, org-scoped, operator+
// (campaigns.activate) — the same level that materializes the send batch. The
// drain refuses unless this is true (plus SEND_ENABLED + CRON_SECRET).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership({
    route: "campaigns/[campaignId]/stages/[stageId]/send/approve",
    method: "POST",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "campaigns.activate")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId: cParam, stageId: sParam } = await params;
  const campaignId = parseId(cParam);
  const stageId = parseId(sParam);
  if (campaignId === null || stageId === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const approved = (json as { approved?: unknown })?.approved;
  if (typeof approved !== "boolean") {
    return apiError(400, "`approved` must be a boolean", API_ERROR_CODES.VALIDATION, {
      field: "approved",
    });
  }

  // 1b rebrand guard: a stage whose sending number belongs to a different brand
  // than its campaign cannot be APPROVED. Write-time only — an already-approved
  // stage with materialized rows keeps sending, because blocking at dispatch
  // would strand real messages (the same rule 1a follows).
  //
  // Only checked when approving. UN-approving a stale stage must always work —
  // that is the operator's way out.
  if (approved) {
    const stale = await isStageNumberBrandStale(db, { orgId, stageId });
    if (stale.stale) {
      return apiError(400, stale.message ?? "Stage number does not match the campaign's brand",
        API_ERROR_CODES.PHONE_BRAND_MISMATCH, { field: "provider_phone_id" });
    }
  }

  const updated = await db
    .update(campaign_stages)
    .set({ send_approved: approved })
    .where(and(eq(campaign_stages.id, stageId), eq(campaign_stages.org_id, orgId)))
    .returning({ id: campaign_stages.id, send_approved: campaign_stages.send_approved });

  if (!updated[0]) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, { entity: "stage" });
  }
  await logCampaignEvent(db, {
    orgId,
    campaignId,
    stageId,
    actorUserId: user.id,
    eventType: "send_approved",
    summary: approved ? "Stage approved to send" : "Stage send approval revoked",
    metadata: { send_approved: approved },
  });
  return NextResponse.json({ ok: true, send_approved: updated[0].send_approved });
}
