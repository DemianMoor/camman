import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaign_stages, campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

function parseId(idParam: string): number | null {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Duplicate a stage as a fresh draft inside the same campaign. Same
// config (creative, URLs, scheduled_at, filters, notes) but send-state
// counters reset and status set to 'draft'. stage_number is
// auto-assigned by the trigger.
export async function POST(
  _req: NextRequest,
  { params }: {
    params: Promise<{ campaignId: string; stageId: string }>;
  },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "stages.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId, stageId } = await params;
  const cid = parseId(campaignId);
  const sid = parseId(stageId);
  if (cid === null || sid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  // Verify campaign belongs to org (cheap pre-check that surfaces the
  // right error before the stage lookup).
  const campaignRow = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.id, cid), eq(campaigns.org_id, orgId)))
    .limit(1);
  if (!campaignRow[0]) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "campaign",
    });
  }

  const sourceRow = await db
    .select()
    .from(campaign_stages)
    .where(
      and(
        eq(campaign_stages.id, sid),
        eq(campaign_stages.campaign_id, cid),
        eq(campaign_stages.org_id, orgId),
      ),
    )
    .limit(1);
  if (!sourceRow[0]) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "stage",
    });
  }
  const source = sourceRow[0];

  // stage_number is filled in by the BEFORE INSERT trigger; cast around
  // the Drizzle type that demands it.
  type StageInsertable = Omit<
    typeof campaign_stages.$inferInsert,
    "stage_number"
  > & { stage_number?: number };
  const values: StageInsertable = {
    org_id: orgId,
    campaign_id: cid,
    label: source.label,
    creative_id: source.creative_id,
    sms_provider_id: source.sms_provider_id,
    provider_phone_id: source.provider_phone_id,
    sales_page_label: source.sales_page_label,
    short_url: source.short_url,
    full_url: source.full_url,
    stop_text: source.stop_text,
    include_clickers: source.include_clickers,
    exclude_clickers: source.exclude_clickers,
    include_no_status: source.include_no_status,
    scheduled_at: source.scheduled_at,
    notes: source.notes,
    status: "draft",
    sms_count: 0,
    total_cost: "0",
    delivered_count: 0,
    opt_out_count: 0,
    click_count: 0,
  };

  const [created] = await db
    .insert(campaign_stages)
    .values(values as typeof campaign_stages.$inferInsert)
    .returning();
  return NextResponse.json(created, { status: 201 });
}
