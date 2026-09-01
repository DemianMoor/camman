import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaign_stages, campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { checkPhoneBrandMatch } from "@/lib/api/brand-number-guard";
import { logCampaignEvent } from "@/lib/campaign-events";
import { can } from "@/lib/permissions";
import {
  generateCampaignTrackingId,
  generateStageTrackingId,
} from "@/lib/tracking-id";
import { STAGE_TRACKING_PARAM, setUrlParam } from "@/lib/stage-url";

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
  const auth = await requireApiMembership({
    route: "campaigns/[campaignId]/stages/[stageId]/duplicate",
    method: "POST",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

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
  // right error before the stage lookup). Also pull brand/offer/tracking
  // so we can mirror the same on-the-fly tracking-id generation as the
  // POST handler.
  const campaignRow = await db
    .select({
      id: campaigns.id,
      brand_id: campaigns.brand_id,
      offer_id: campaigns.offer_id,
      tracking_id: campaigns.tracking_id,
      created_at: campaigns.created_at,
    })
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

  // Brand → numbers (1a). A duplicate CREATES a stage, so it is held to the
  // create rule, not the grandfathering rule — copying a legacy mismatched
  // stage would otherwise mint new mismatches indefinitely and make the whole
  // check decorative.
  //
  // ⚠️ OPERATIONAL BITE: this is the one place 1a changes an existing habit.
  // Rolling a daily campaign forward by duplicating yesterday's stage now fails
  // for a campaign whose number belongs to another brand (today: Guide Kin
  // campaigns on phone 114, a LumZen number). The fix is to give the campaign a
  // number of its own brand; the error names both brands. If this proves too
  // disruptive before a replacement number exists, deleting this one block
  // restores the old behavior without touching anything else.
  {
    const mismatch = await checkPhoneBrandMatch(db, {
      orgId,
      providerPhoneId: source.provider_phone_id,
      campaignBrandId: campaignRow[0].brand_id,
    });
    if (mismatch) {
      return apiError(400, mismatch.message, API_ERROR_CODES.PHONE_BRAND_MISMATCH, {
        field: "provider_phone_id",
        phone_brand_id: mismatch.phoneBrandId,
        campaign_brand_id: mismatch.campaignBrandId,
      });
    }
  }

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
    // 1b: a copy carries the landing PAGE, not a frozen URL. The duplicate's
    // destination is re-constructed at mint time from ITS campaign's brand, so
    // copying a stage into a differently-branded campaign lands on the right
    // host automatically.
    landing_page_id: source.landing_page_id,
    sales_page_label: source.sales_page_label,
    short_url: source.short_url,
    full_url: source.full_url,
    stop_text: source.stop_text,
    include_clickers: source.include_clickers,
    exclude_clickers: source.exclude_clickers,
    include_no_status: source.include_no_status,
    // A copy NEVER inherits the parent's send date — a stale (past) date would
    // auto-fire the moment the stage is approved. Operator must set a fresh
    // date; the send pipeline refuses a null-scheduled stage (no_schedule).
    scheduled_at: null,
    notes: source.notes,
    status: "draft",
    // The DUPLICATOR owns the copy, not whoever created the original: the
    // person who pressed Duplicate is the one whose deactivation should disarm
    // it (migration 0175).
    created_by_user_id: user.id,
    sms_count: 0,
    total_cost: "0",
    delivered_count: 0,
    opt_out_count: 0,
    click_count: 0,
  };

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(campaign_stages)
      .values(values as typeof campaign_stages.$inferInsert)
      .returning();

    // Mirror the POST handler: backfill the parent tracking_id if it's
    // missing but brand+offer exist, then generate this stage's
    // tracking_id from the parent + (auto-assigned) stage_number +
    // creative_id. Duplicating a stage with no creative_id produces a
    // stage row with NULL tracking_id, same as the create path.
    let parentTrackingId = campaignRow[0].tracking_id;
    if (
      parentTrackingId == null &&
      campaignRow[0].brand_id != null &&
      campaignRow[0].offer_id != null
    ) {
      parentTrackingId = await generateCampaignTrackingId(tx, {
        orgId,
        brandId: campaignRow[0].brand_id,
        offerId: campaignRow[0].offer_id,
        createdAt: campaignRow[0].created_at,
      });
      await tx
        .update(campaigns)
        .set({ tracking_id: parentTrackingId })
        .where(eq(campaigns.id, cid));
    }

    let finalRow = row;
    if (parentTrackingId != null && row.creative_id != null) {
      const stageTrackingId = generateStageTrackingId({
        campaignTrackingId: parentTrackingId,
        stageNumber: row.stage_number,
        creativeId: row.creative_id,
      });
      // Rewrite ONLY sub_id3 in the inherited tracking URL to point at THIS
      // stage's new tracking ID, preserving every other param (sub_id1 etc.).
      // No URL ⇒ nothing to rewrite.
      const rewrittenFullUrl = row.full_url
        ? setUrlParam(row.full_url, STAGE_TRACKING_PARAM, stageTrackingId)
        : row.full_url;
      const [withTracking] = await tx
        .update(campaign_stages)
        .set({ tracking_id: stageTrackingId, full_url: rewrittenFullUrl })
        .where(eq(campaign_stages.id, row.id))
        .returning();
      finalRow = withTracking;
    }

    await logCampaignEvent(tx, {
      orgId,
      campaignId: cid,
      stageId: finalRow.id,
      actorUserId: user.id,
      eventType: "stage_created",
      summary: `Stage ${finalRow.stage_number} created (duplicated from stage ${sid})`,
      metadata: { stage_number: finalRow.stage_number, duplicated_from_stage_id: sid },
    });

    return finalRow;
  });

  return NextResponse.json(created, { status: 201 });
}
