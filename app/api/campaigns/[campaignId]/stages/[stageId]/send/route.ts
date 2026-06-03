import { and, eq, sql as drizzleSql } from "drizzle-orm";
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

// Send-panel status for a stage: the gate states + live stage_sends counts.
// Read-only, session-gated (campaigns.view), org-scoped. `send_enabled` is the
// boolean form of SEND_ENABLED only — never the raw env value.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { stageId: sParam } = await params;
  const stageId = parseId(sParam);
  if (stageId === null) {
    return apiError(400, "Invalid stage id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }

  const stage = await db
    .select({ send_approved: campaign_stages.send_approved })
    .from(campaign_stages)
    .where(and(eq(campaign_stages.id, stageId), eq(campaign_stages.org_id, orgId)))
    .limit(1);
  if (!stage[0]) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, { entity: "stage" });
  }

  const counts = (await db.execute(drizzleSql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'pending')::int  AS pending,
      count(*) FILTER (WHERE status = 'sending')::int  AS sending,
      count(*) FILTER (WHERE status = 'sent')::int     AS sent,
      count(*) FILTER (WHERE status = 'failed')::int   AS failed
    FROM stage_sends WHERE stage_id = ${stageId} AND org_id = ${orgId}
  `)) as unknown as {
    total: number;
    pending: number;
    sending: number;
    sent: number;
    failed: number;
  }[];

  const c = counts[0] ?? { total: 0, pending: 0, sending: 0, sent: 0, failed: 0 };

  return NextResponse.json({
    send_approved: stage[0].send_approved,
    send_enabled: process.env.SEND_ENABLED === "true",
    counts: {
      total: Number(c.total),
      pending: Number(c.pending),
      sending: Number(c.sending),
      sent: Number(c.sent),
      failed: Number(c.failed),
    },
  });
}
