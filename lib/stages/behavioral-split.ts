import { and, eq, ne, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { campaign_stages, campaigns } from "@/db/schema";
import {
  generateCampaignTrackingId,
  generateStageTrackingId,
} from "@/lib/tracking-id";
import { STAGE_TRACKING_PARAM, setUrlParam } from "@/lib/stage-url";

// Core of the behavioral-split endpoint, factored out of the route so it can be
// tested directly against a throwaway org (the route resolves org from the auth
// session, which a test harness can't pin). The route is a thin auth + error-map
// wrapper around this. Structure mirrors the A/B split route's transaction/clone.
//
// The chosen stage becomes the PARENT position and stays an ORDINARY stage; we
// stamp three lane-stages under it, one per behavioral tier (0 ignored / 1
// clicked / 2 reached offer). Tier 3 (converted) gets no lane — those contacts
// exit. Each lane clones the parent's config, sets behavioral_tier +
// parent_stage_id, regenerates its own stage tracking_id, and leaves
// split_index/split_total NULL (lanes partition by tier, not the A/B partition).

// tier → human label for the lane's starting label. Tier 3 deliberately absent.
export const LANE_TIERS = [
  { tier: 0, label: "Ignored" },
  { tier: 1, label: "Clicked" },
  { tier: 2, label: "Reached offer" },
] as const;

export type BehavioralSplitResult =
  | {
      ok: true;
      parent_stage_id: number;
      lane_stage_ids: number[];
      tiers: (number | null)[];
    }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      details?: unknown;
    };

export async function performBehavioralSplit(
  opts: { orgId: string; campaignId: number; stageId: number },
  database: typeof db = db,
): Promise<BehavioralSplitResult> {
  const { orgId, campaignId, stageId } = opts;

  const campaignRow = await database
    .select({
      id: campaigns.id,
      brand_id: campaigns.brand_id,
      offer_id: campaigns.offer_id,
      tracking_id: campaigns.tracking_id,
      created_at: campaigns.created_at,
    })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.org_id, orgId)))
    .limit(1);
  if (!campaignRow[0]) {
    return {
      ok: false,
      status: 404,
      code: "not_found",
      message: "Campaign not found",
      details: { entity: "campaign" },
    };
  }

  const sourceRow = await database
    .select()
    .from(campaign_stages)
    .where(
      and(
        eq(campaign_stages.id, stageId),
        eq(campaign_stages.campaign_id, campaignId),
        eq(campaign_stages.org_id, orgId),
      ),
    )
    .limit(1);
  if (!sourceRow[0]) {
    return {
      ok: false,
      status: 404,
      code: "not_found",
      message: "Stage not found",
      details: { entity: "stage" },
    };
  }
  const source = sourceRow[0];

  // Guard: can't behaviorally split a stage that is itself a lane (no chaining).
  if (source.behavioral_tier !== null) {
    return {
      ok: false,
      status: 409,
      code: "conflict",
      message: "This stage is itself a behavioral lane and can't be split again.",
      details: { reason: "already_lane", behavioral_tier: source.behavioral_tier },
    };
  }

  // Guard: archived stages can't be split (mirrors the A/B split route).
  if (source.status === "archived") {
    return {
      ok: false,
      status: 409,
      code: "conflict",
      message: "Archived stages can't be split. Restore the stage first.",
      details: { reason: "archived" },
    };
  }

  // Guard (behavioral analog of A/B's "already split"): refuse if this stage
  // still has LIVE (non-archived) behavioral lanes, so we never stack a second
  // trio. Archived lanes are excluded — archiving the accidental lanes frees the
  // parent to be re-split (matches the A/B re-split rule).
  const existingLanes = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(campaign_stages)
    .where(
      and(
        eq(campaign_stages.parent_stage_id, stageId),
        eq(campaign_stages.org_id, orgId),
        ne(campaign_stages.status, "archived"),
      ),
    );
  if (Number(existingLanes[0]?.n ?? 0) > 0) {
    return {
      ok: false,
      status: 409,
      code: "conflict",
      message: "This stage already has behavioral lanes. Delete them before re-splitting.",
      details: { reason: "already_behaviorally_split" },
    };
  }

  const baseLabel = source.label ?? `Stage ${source.stage_number}`;

  return database.transaction(async (tx) => {
    // Backfill the parent campaign's tracking_id if missing but brand+offer
    // exist — mirrors the stage POST / duplicate / A/B-split paths.
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
        .where(eq(campaigns.id, campaignId));
    }

    // One lane per tier. stage_number is auto-assigned by the BEFORE INSERT
    // trigger; send-state counters reset; split_index/split_total left NULL.
    type StageInsertable = Omit<
      typeof campaign_stages.$inferInsert,
      "stage_number"
    > & { stage_number?: number };
    const newRows: StageInsertable[] = LANE_TIERS.map(({ tier, label }) => ({
      org_id: orgId,
      campaign_id: campaignId,
      label: `${baseLabel} — ${label} (tier ${tier})`,
      creative_id: source.creative_id,
      sms_provider_id: source.sms_provider_id,
      provider_phone_id: source.provider_phone_id,
      sales_page_label: source.sales_page_label,
      short_url: source.short_url,
      full_url: source.full_url,
      utm_tag_ids: source.utm_tag_ids,
      stop_text: source.stop_text,
      include_clickers: source.include_clickers,
      exclude_clickers: source.exclude_clickers,
      include_no_status: source.include_no_status,
      // A lane NEVER inherits the parent's send date — a stale (past) date would
      // auto-fire on approval. Operator sets a fresh date per lane; the send
      // pipeline refuses a null-scheduled stage (no_schedule).
      scheduled_at: null,
      notes: source.notes,
      status: "draft",
      sms_count: 0,
      total_cost: "0",
      delivered_count: 0,
      opt_out_count: 0,
      click_count: 0,
      // The behavioral identity — set together, coherent with the CHECK.
      behavioral_tier: tier,
      parent_stage_id: source.id,
    }));

    const insertedStages = await tx
      .insert(campaign_stages)
      .values(newRows as (typeof campaign_stages.$inferInsert)[])
      .returning({
        id: campaign_stages.id,
        stage_number: campaign_stages.stage_number,
        creative_id: campaign_stages.creative_id,
        behavioral_tier: campaign_stages.behavioral_tier,
        full_url: campaign_stages.full_url,
      });

    // Each lane gets its own stage tracking_id (distinct stage_number ⇒ distinct
    // id). Skip lanes without a creative_id (mirrors the stage POST behavior).
    if (parentTrackingId != null) {
      for (const s of insertedStages) {
        if (s.creative_id == null) continue;
        const stageTrackingId = generateStageTrackingId({
          campaignTrackingId: parentTrackingId,
          stageNumber: s.stage_number,
          creativeId: s.creative_id,
        });
        // Rewrite ONLY sub_id3 in the inherited URL to this lane's own tracking
        // ID, preserving all other params. No URL ⇒ nothing to rewrite.
        const rewrittenFullUrl = s.full_url
          ? setUrlParam(s.full_url, STAGE_TRACKING_PARAM, stageTrackingId)
          : s.full_url;
        await tx
          .update(campaign_stages)
          .set({ tracking_id: stageTrackingId, full_url: rewrittenFullUrl })
          .where(eq(campaign_stages.id, s.id));
      }
    }

    return {
      ok: true as const,
      parent_stage_id: source.id,
      lane_stage_ids: insertedStages.map((s) => s.id),
      tiers: insertedStages.map((s) => s.behavioral_tier),
    };
  });
}
