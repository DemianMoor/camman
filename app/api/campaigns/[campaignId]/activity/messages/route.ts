import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

export const dynamic = "force-dynamic";

const SEND_STATUSES = new Set([
  "pending",
  "sending",
  "sent",
  "failed",
  "rejected",
  // TextHub-suppressed. Filterable on its own, but deliberately NOT part of the
  // "attention" quick-filter below — a suppression isn't a row a human must fix.
  "filtered",
]);

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Per-recipient send drill-down for the Activity tab. Paginated, newest first,
// filterable by stage / status / phone substring. Each row is joined to its
// latest matching TextHub inbound event (reply / DLR), matched on
// texthub_message_id = provider_message_id. Reads stage_sends live — these rows
// are NOT duplicated into campaign_events.
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
    Math.max(1, Number(url.searchParams.get("pageSize") ?? "50") || 50),
  );
  const offset = (page - 1) * pageSize;

  const stageId = parseId(url.searchParams.get("stageId") ?? "");
  const statusRaw = url.searchParams.get("status") ?? "";
  // "attention" is a WS4 §B7 quick filter: every row that needs a human —
  // failed, provider-rejected, or stuck mid-send (never auto-retried).
  const status =
    statusRaw === "attention"
      ? "attention"
      : SEND_STATUSES.has(statusRaw)
        ? statusRaw
        : null;
  const search = (url.searchParams.get("search") ?? "").trim();

  // Shared filter predicate (drizzle sql fragments compose cleanly).
  const filters = [
    drizzleSql`ss.org_id = ${orgId}`,
    drizzleSql`ss.campaign_id = ${campaignId}`,
  ];
  if (stageId !== null) filters.push(drizzleSql`ss.stage_id = ${stageId}`);
  if (status === "attention") {
    filters.push(drizzleSql`ss.status IN ('failed', 'rejected', 'sending')`);
  } else if (status !== null) {
    filters.push(drizzleSql`ss.status = ${status}`);
  }
  if (search) filters.push(drizzleSql`ss.phone ILIKE ${"%" + search + "%"}`);
  const whereClause = drizzleSql.join(filters, drizzleSql` AND `);

  const rows = (await db.execute(drizzleSql`
    SELECT
      ss.id::text             AS id,
      ss.stage_id             AS stage_id,
      cs.stage_number         AS stage_number,
      ss.phone                AS phone,
      ss.status               AS status,
      ss.sent_at              AS sent_at,
      ss.created_at           AS created_at,
      ss.texthub_message_id   AS texthub_message_id,
      ss.attempts             AS attempts,
      ss.last_error           AS last_error,
      ss.sale_status          AS sale_status,
      ss.sale_revenue         AS sale_revenue,
      reply.result            AS reply_result,
      reply.received_at       AS reply_received_at
    FROM stage_sends ss
    JOIN campaign_stages cs ON cs.id = ss.stage_id
    LEFT JOIN LATERAL (
      SELECT ie.result, ie.received_at
      FROM texthub_inbound_events ie
      WHERE ie.org_id = ss.org_id
        AND ss.texthub_message_id IS NOT NULL
        AND ie.provider_message_id = ss.texthub_message_id
      ORDER BY ie.received_at DESC
      LIMIT 1
    ) reply ON true
    WHERE ${whereClause}
    ORDER BY ss.created_at DESC, ss.id DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `)) as unknown as {
    id: string;
    stage_id: number;
    stage_number: number;
    phone: string;
    status: string;
    sent_at: string | null;
    created_at: string;
    texthub_message_id: string | null;
    attempts: number;
    last_error: string | null;
    sale_status: string | null;
    sale_revenue: string | null;
    reply_result: string | null;
    reply_received_at: string | null;
  }[];

  const countRows = (await db.execute(drizzleSql`
    SELECT count(*)::int AS n
    FROM stage_sends ss
    WHERE ${whereClause}
  `)) as unknown as { n: number }[];

  return NextResponse.json({
    data: rows,
    totalCount: countRows[0]?.n ?? 0,
    page,
    pageSize,
  });
}
