import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaign_stages } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { stageStatusChangeSchema } from "@/lib/validators/campaign-stages";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Stage status is freely assignable among the non-archived states so an
// operator can record the resulting status of a send directly (e.g. mark a
// stage 'success' or 'failed' after importing results) without stepping
// through the lifecycle. `archived` is NOT a target here — that goes through
// /archive — and an archived stage must be restored before its status can
// change again. Moving INTO 'sent' stamps `sent_at`; the validator already
// restricts `next` to the six active statuses.

export async function POST(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "stages.send")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId, stageId } = await params;
  const cid = parseId(campaignId);
  const sid = parseId(stageId);
  if (cid === null || sid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = stageStatusChangeSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const next = parsed.data.status;

  const current = await db
    .select({ status: campaign_stages.status })
    .from(campaign_stages)
    .where(
      and(
        eq(campaign_stages.id, sid),
        eq(campaign_stages.campaign_id, cid),
        eq(campaign_stages.org_id, orgId),
      ),
    )
    .limit(1);
  if (!current[0]) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "stage",
    });
  }
  const from = current[0].status;
  if (from === "archived") {
    return apiError(
      409,
      "Restore the stage before changing its status",
      API_ERROR_CODES.CONFLICT,
      { reason: "stage_is_archived" },
    );
  }

  const [updated] = await db
    .update(campaign_stages)
    .set({
      status: next,
      previous_status: from,
      status_changed_at: drizzleSql`now()`,
      // Only stamp sent_at when actually entering the 'sent' state.
      sent_at: next === "sent" ? drizzleSql`now()` : undefined,
    })
    .where(
      and(
        eq(campaign_stages.id, sid),
        eq(campaign_stages.campaign_id, cid),
        eq(campaign_stages.org_id, orgId),
      ),
    )
    .returning();
  return NextResponse.json(updated);
}
