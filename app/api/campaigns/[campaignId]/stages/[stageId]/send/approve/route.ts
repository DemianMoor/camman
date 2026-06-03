import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaign_stages } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
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
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.activate")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { stageId: sParam } = await params;
  const stageId = parseId(sParam);
  if (stageId === null) {
    return apiError(400, "Invalid stage id", API_ERROR_CODES.VALIDATION, { field: "id" });
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

  const updated = await db
    .update(campaign_stages)
    .set({ send_approved: approved })
    .where(and(eq(campaign_stages.id, stageId), eq(campaign_stages.org_id, orgId)))
    .returning({ id: campaign_stages.id, send_approved: campaign_stages.send_approved });

  if (!updated[0]) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, { entity: "stage" });
  }
  return NextResponse.json({ ok: true, send_approved: updated[0].send_approved });
}
