import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaign_stages } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { chunkedQuery, streamCsvResponse } from "@/lib/csv/stream-export";
import { can } from "@/lib/permissions";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Escalation packet export (Workstream 3, Guarantee 4 / UI). For every row whose
// latest attempt is TextHub's to explain (`theirs_rejected`) or genuinely unknown
// (`indeterminate`), emit the evidence needed to open a case with TextHub:
// recipient number, their own message id (resolvable on their side without a
// status endpoint), timestamp, classification, HTTP status, the EXACT request
// (api_key already redacted at storage), and their verbatim response.
//
// Contains no secrets — request_redacted is stored pre-redacted. Read-equivalent,
// so gated on stages.view (mirrors export-phones).
type Row = {
  phone: string;
  texthub_message_id: string | null;
  attempted_at: string;
  classification: string;
  http_status: number;
  request_redacted: string | null;
  raw_body: string | null;
  error: string | null;
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "stages.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId, stageId } = await params;
  const cid = parseId(campaignId);
  const sid = parseId(stageId);
  if (cid === null || sid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  const stageRows = await db
    .select({ tracking_id: campaign_stages.tracking_id })
    .from(campaign_stages)
    .where(
      and(
        eq(campaign_stages.id, sid),
        eq(campaign_stages.campaign_id, cid),
        eq(campaign_stages.org_id, orgId),
      ),
    )
    .limit(1);
  if (!stageRows[0]) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, { entity: "stage" });
  }
  const label = stageRows[0].tracking_id ?? `stage-${sid}`;

  // Small dataset (only theirs/indeterminate failures), so one query, returned in
  // the first chunk. Latest attempt per recipient.
  const rowSource = chunkedQuery<Row>({
    fetchChunk: async (offset) => {
      if (offset > 0) return [];
      return (await db.execute(sql`
        WITH latest AS (
          SELECT DISTINCT ON (sa.stage_send_id)
            sa.stage_send_id, sa.classification, sa.http_status, sa.request_redacted,
            sa.raw_body, sa.error, sa.created_at AS attempted_at,
            ss.phone, ss.texthub_message_id
          FROM send_attempts sa
          JOIN stage_sends ss ON ss.id = sa.stage_send_id
          WHERE ss.stage_id = ${sid} AND ss.org_id = ${orgId}::uuid
          ORDER BY sa.stage_send_id, sa.id DESC
        )
        SELECT phone, texthub_message_id, attempted_at, classification,
               http_status, request_redacted, raw_body, error
        FROM latest
        WHERE classification IN ('theirs_rejected', 'indeterminate')
        ORDER BY attempted_at ASC
      `)) as unknown as Row[];
    },
  });

  return streamCsvResponse<Row>({
    filename: `escalation_${label}.csv`,
    columns: [
      { key: "phone", label: "Number" },
      { key: "texthub_message_id", label: "TextHub Message ID" },
      { key: "attempted_at", label: "Attempted At" },
      { key: "classification", label: "Classification" },
      { key: "http_status", label: "HTTP Status" },
      { key: "request_redacted", label: "Request (key redacted)" },
      { key: "raw_body", label: "TextHub Response" },
      { key: "error", label: "Normalized Error" },
    ],
    rowSource,
    rowMapper: (r) => ({
      phone: r.phone,
      texthub_message_id: r.texthub_message_id ?? "",
      attempted_at: r.attempted_at,
      classification: r.classification,
      http_status: String(r.http_status),
      request_redacted: r.request_redacted ?? "",
      raw_body: r.raw_body ?? "",
      error: r.error ?? "",
    }),
  });
}
