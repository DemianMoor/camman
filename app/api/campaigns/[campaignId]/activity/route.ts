import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import {
  countCampaignOptOuts,
  getCampaignDeliveryRows,
  summarizeCampaignDelivery,
} from "@/lib/reporting/campaign-activity";
import { getPhoneDirectory } from "@/lib/reporting/delivery";

export const dynamic = "force-dynamic";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Campaign Activity tab — read-only. Returns:
//   • summary: send-status rollup across this campaign's stage_sends, opt-outs
//     (STOP replies linked to a send, every provider), last send time, per-stage
//     rows, and the delivery cards (lib/reporting/campaign-activity.ts).
//   • events: the campaign_events audit timeline, newest first, paginated, with
//     the actor's display name resolved from auth.users (NULL actor = System).
// The per-recipient message drill-down lives in ./activity/messages.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership({
    route: "campaigns/[campaignId]/activity",
    method: "GET",
  });
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
    .select({
      id: campaigns.id,
      // The delivery cards are scoped by stage (the rollup and the live query
      // both narrow on stage_id), so the ids ride along with the 404 gate.
      // ⚠️ Literal qualified names: in a single-table select drizzle renders
      // ${table.col} unqualified, which would bind to the inner table here.
      stage_ids: drizzleSql<number[]>`coalesce((
        SELECT array_agg(cs.id) FROM campaign_stages cs
        WHERE cs.campaign_id = "campaigns"."id" AND cs.org_id = ${orgId}
      ), '{}')`,
    })
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

  const stageIds = owns[0].stage_ids.map(Number);

  // These are independent — run them in one round-trip, not serially (the
  // ownership check above already gated the 404). On the transaction pooler
  // each await is a separate RTT, so serial was ~6× the latency.
  const deliveryPromise = Promise.all([
    getCampaignDeliveryRows(orgId, stageIds),
    getPhoneDirectory(orgId),
  ]);
  const [totals, optOuts, byStage, eventRows, countRows] = (await Promise.all([
    // ---- Send-status rollup (campaign-wide).
    db.execute(drizzleSql`
      SELECT
        count(*) FILTER (WHERE status = 'sent')::int      AS sent,
        count(*) FILTER (WHERE status = 'failed')::int    AS failed,
        count(*) FILTER (WHERE status = 'rejected')::int  AS rejected,
        count(*) FILTER (WHERE status = 'filtered')::int  AS filtered,
        count(*) FILTER (WHERE status = 'skipped_duplicate')::int AS skipped_duplicate,
        count(*) FILTER (WHERE status = 'skipped_opted_out')::int AS skipped_opted_out,
        count(*) FILTER (WHERE status = 'skipped_ineligible')::int AS skipped_ineligible,
        count(*) FILTER (WHERE status = 'pending')::int   AS pending,
        count(*) FILTER (WHERE status = 'sending')::int   AS sending,
        count(*)::int                                     AS total,
        max(sent_at)                                      AS last_sent_at
      FROM stage_sends
      WHERE org_id = ${orgId} AND campaign_id = ${campaignId}
    `),
    // ---- Opt-outs: STOP replies linked to this campaign's sends, every provider.
    countCampaignOptOuts(db, orgId, campaignId),
    // ---- Per-stage send breakdown.
    db.execute(drizzleSql`
      SELECT
        ss.stage_id                                       AS stage_id,
        cs.stage_number                                   AS stage_number,
        count(*) FILTER (WHERE ss.status = 'sent')::int   AS sent,
        count(*) FILTER (WHERE ss.status = 'failed')::int AS failed,
        count(*) FILTER (WHERE ss.status = 'filtered')::int AS filtered,
        count(*) FILTER (WHERE ss.status = 'skipped_duplicate')::int AS skipped_duplicate,
        count(*) FILTER (WHERE ss.status IN ('pending','sending'))::int AS pending,
        count(*)::int                                     AS total,
        max(ss.sent_at)                                   AS last_sent_at
      FROM stage_sends ss
      JOIN campaign_stages cs ON cs.id = ss.stage_id
      WHERE ss.org_id = ${orgId} AND ss.campaign_id = ${campaignId}
      GROUP BY ss.stage_id, cs.stage_number
      ORDER BY cs.stage_number ASC
    `),
    // ---- Event timeline (paginated, newest first).
    db.execute(drizzleSql`
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
    `),
    db.execute(drizzleSql`
      SELECT count(*)::int AS n
      FROM campaign_events
      WHERE org_id = ${orgId} AND campaign_id = ${campaignId}
    `),
  ])) as unknown as [
    {
      sent: number;
      failed: number;
      rejected: number;
      filtered: number;
      skipped_duplicate: number;
      skipped_opted_out: number;
      skipped_ineligible: number;
      pending: number;
      sending: number;
      total: number;
      last_sent_at: string | null;
    }[],
    number,
    {
      stage_id: number;
      stage_number: number;
      sent: number;
      failed: number;
      filtered: number;
      skipped_duplicate: number;
      pending: number;
      total: number;
      last_sent_at: string | null;
    }[],
    {
      id: string;
      event_type: string;
      summary: string;
      metadata: Record<string, unknown> | null;
      stage_id: number | null;
      created_at: string;
      actor_user_id: string | null;
      actor_name: string | null;
    }[],
    { n: number }[],
  ];

  const [deliveryRows, phones] = await deliveryPromise;
  const delivery = summarizeCampaignDelivery(
    deliveryRows.matured,
    deliveryRows.pending,
    phones,
  );

  const t = totals[0];
  return NextResponse.json({
    summary: {
      // Messages Sent IS the delivery base (rollup + live), so the cards below
      // it can never be computed over a different number of sends.
      // scripts/verify-delivery-grains.ts asserts it equals the direct
      // status='sent' count.
      sent: delivery.sent,
      failed: t?.failed ?? 0,
      rejected: t?.rejected ?? 0,
      filtered: t?.filtered ?? 0,
      skipped_duplicate: t?.skipped_duplicate ?? 0,
      skipped_opted_out: t?.skipped_opted_out ?? 0,
      skipped_ineligible: t?.skipped_ineligible ?? 0,
      pending: t?.pending ?? 0,
      sending: t?.sending ?? 0,
      total: t?.total ?? 0,
      opt_outs: optOuts,
      last_sent_at: t?.last_sent_at ?? null,
      by_stage: byStage,
      delivery,
    },
    events: {
      data: eventRows,
      totalCount: countRows[0]?.n ?? 0,
      page,
      pageSize,
    },
  });
}
