import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

export const dynamic = "force-dynamic";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Campaign Activity tab — read-only. Returns:
//   • summary: send-status rollup across this campaign's stage_sends (+ replies
//     matched from TextHub inbound events + last send time + per-stage rows).
//   • events: the campaign_events audit timeline, newest first, paginated, with
//     the actor's display name resolved from auth.users (NULL actor = System).
// The per-recipient message drill-down lives in ./activity/messages.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId: cIdParam } = await params;
  const campaignId = parseId(cIdParam);
  if (campaignId === null) {
    return apiError(400, "Invalid campaign id", API_ERROR_CODES.VALIDATION);
  }

  const owns = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.org_id, orgId)))
    .limit(1);
  if (!owns[0]) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "campaign",
    });
  }

  const url = req.nextUrl;
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("pageSize") ?? "30") || 30),
  );
  const offset = (page - 1) * pageSize;

  // ---- Send-status rollup (campaign-wide).
  const totals = (await db.execute(drizzleSql`
    SELECT
      count(*) FILTER (WHERE status = 'sent')::int      AS sent,
      count(*) FILTER (WHERE status = 'failed')::int    AS failed,
      count(*) FILTER (WHERE status = 'rejected')::int  AS rejected,
      count(*) FILTER (WHERE status = 'pending')::int   AS pending,
      count(*) FILTER (WHERE status = 'sending')::int   AS sending,
      count(*)::int                                     AS total,
      max(sent_at)                                      AS last_sent_at
    FROM stage_sends
    WHERE org_id = ${orgId} AND campaign_id = ${campaignId}
  `)) as unknown as {
    sent: number;
    failed: number;
    rejected: number;
    pending: number;
    sending: number;
    total: number;
    last_sent_at: string | null;
  }[];

  // ---- Replies: TextHub inbound events matched to this campaign's sends.
  const replyRows = (await db.execute(drizzleSql`
    SELECT count(DISTINCT ie.id)::int AS replies
    FROM texthub_inbound_events ie
    JOIN stage_sends ss
      ON ss.texthub_message_id = ie.provider_message_id
     AND ss.org_id = ie.org_id
    WHERE ie.org_id = ${orgId}
      AND ss.campaign_id = ${campaignId}
      AND ie.provider_message_id IS NOT NULL
  `)) as unknown as { replies: number }[];

  // ---- Per-stage send breakdown.
  const byStage = (await db.execute(drizzleSql`
    SELECT
      ss.stage_id                                       AS stage_id,
      cs.stage_number                                   AS stage_number,
      count(*) FILTER (WHERE ss.status = 'sent')::int   AS sent,
      count(*) FILTER (WHERE ss.status = 'failed')::int AS failed,
      count(*) FILTER (WHERE ss.status IN ('pending','sending'))::int AS pending,
      count(*)::int                                     AS total,
      max(ss.sent_at)                                   AS last_sent_at
    FROM stage_sends ss
    JOIN campaign_stages cs ON cs.id = ss.stage_id
    WHERE ss.org_id = ${orgId} AND ss.campaign_id = ${campaignId}
    GROUP BY ss.stage_id, cs.stage_number
    ORDER BY cs.stage_number ASC
  `)) as unknown as {
    stage_id: number;
    stage_number: number;
    sent: number;
    failed: number;
    pending: number;
    total: number;
    last_sent_at: string | null;
  }[];

  // ---- Event timeline (paginated, newest first).
  const eventRows = (await db.execute(drizzleSql`
    SELECT
      ce.id::text       AS id,
      ce.event_type     AS event_type,
      ce.summary        AS summary,
      ce.metadata       AS metadata,
      ce.stage_id       AS stage_id,
      ce.created_at     AS created_at,
      ce.actor_user_id  AS actor_user_id,
      CASE WHEN ce.actor_user_id IS NULL THEN NULL
           ELSE COALESCE(u.raw_user_meta_data->>'display_name', u.email)
      END               AS actor_name
    FROM campaign_events ce
    LEFT JOIN auth.users u ON u.id = ce.actor_user_id
    WHERE ce.org_id = ${orgId} AND ce.campaign_id = ${campaignId}
    ORDER BY ce.created_at DESC, ce.id DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `)) as unknown as {
    id: string;
    event_type: string;
    summary: string;
    metadata: Record<string, unknown> | null;
    stage_id: number | null;
    created_at: string;
    actor_user_id: string | null;
    actor_name: string | null;
  }[];

  const countRows = (await db.execute(drizzleSql`
    SELECT count(*)::int AS n
    FROM campaign_events
    WHERE org_id = ${orgId} AND campaign_id = ${campaignId}
  `)) as unknown as { n: number }[];

  const t = totals[0];
  return NextResponse.json({
    summary: {
      sent: t?.sent ?? 0,
      failed: t?.failed ?? 0,
      rejected: t?.rejected ?? 0,
      pending: t?.pending ?? 0,
      sending: t?.sending ?? 0,
      total: t?.total ?? 0,
      replies: replyRows[0]?.replies ?? 0,
      last_sent_at: t?.last_sent_at ?? null,
      by_stage: byStage,
    },
    events: {
      data: eventRows,
      totalCount: countRows[0]?.n ?? 0,
      page,
      pageSize,
    },
  });
}
