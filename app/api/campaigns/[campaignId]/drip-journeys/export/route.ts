import { and, eq } from "drizzle-orm";
import { sql as drizzleSql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { buildExportFilename, chunkedQuery, streamCsvResponse } from "@/lib/csv/stream-export";
import { can } from "@/lib/permissions";
import { formatPhoneForExport } from "@/lib/phone-validation";

// Every routed lead of one drip campaign, as a CSV for spreadsheet viewing.
// Replaces the inline journey list on the campaign page, which rendered each
// journey's raw routing JSON and stopped at 50 rows.
//
// Times are ET wall-clock as "yyyy-MM-dd HH:mm" — sortable in a spreadsheet,
// unlike the UI's "Oct 6, 2026 5:46 PM ET".
export const maxDuration = 60;

const ET = (v: string | null) => (v ? formatInCampaignTimezone(v, "yyyy-MM-dd HH:mm") : "");

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  // Same gate as the drip-journeys list this replaces.
  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  const { campaignId: raw } = await params;
  const cid = Number(raw);
  if (!Number.isInteger(cid) || cid <= 0) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  const found = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.id, cid), eq(campaigns.org_id, orgId)))
    .limit(1);
  if (!found[0]) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, { entity: "campaign" });
  }

  type Row = {
    phone_number: string | null;
    state: string;
    close_reason: string | null;
    routed_at: string | null;
    first_send_at: string | null;
    closed_at: string | null;
    partner_slug: string | null;
    interest_tag: string | null;
    received_at: string | null;
    line_type: string | null;
    us_state: string | null;
  };

  // ORDER BY includes j.id so offset pagination is stable when routed_at ties
  // (a routing batch stamps one routed_at on every journey it admits).
  const rowSource = chunkedQuery<Row>({
    fetchChunk: async (offset, limit) =>
      (await db.execute(drizzleSql`
        SELECT c.phone_number, j.state, j.close_reason, j.routed_at, j.first_send_at, j.closed_at,
               le.partner_slug, le.interest_tag, le.received_at, le.line_type,
               ca.state AS us_state
        FROM drip_journeys j
        JOIN contacts c ON c.id = j.contact_id
        LEFT JOIN lead_events le ON le.id = j.lead_event_id
        LEFT JOIN contact_attributes ca ON ca.contact_id = j.contact_id
        WHERE j.org_id = ${orgId}::uuid AND j.campaign_id = ${cid}
        ORDER BY j.routed_at DESC, j.id
        OFFSET ${offset} LIMIT ${limit}
      `)) as unknown as Row[],
  });

  return streamCsvResponse({
    filename: buildExportFilename(`campaign-${cid}-routed-leads`),
    columns: [
      { key: "phone", label: "Phone" },
      { key: "state", label: "Journey status" },
      { key: "close_reason", label: "Close reason" },
      { key: "routed_at", label: "Routed at (ET)" },
      { key: "first_send_at", label: "First sent at (ET)" },
      { key: "closed_at", label: "Closed at (ET)" },
      { key: "partner", label: "Partner" },
      { key: "interest_tag", label: "Interest tag" },
      { key: "received_at", label: "Lead received at (ET)" },
      { key: "line_type", label: "Line type" },
      { key: "us_state", label: "State" },
    ],
    rowSource,
    rowMapper: (r) => ({
      phone: formatPhoneForExport(r.phone_number),
      state: r.state,
      close_reason: r.close_reason,
      routed_at: ET(r.routed_at),
      first_send_at: ET(r.first_send_at),
      closed_at: ET(r.closed_at),
      partner: r.partner_slug,
      interest_tag: r.interest_tag,
      received_at: ET(r.received_at),
      line_type: r.line_type,
      us_state: r.us_state,
    }),
  });
}
