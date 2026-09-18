import { and, eq, ne, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { campaign_stages, campaign_stage_split_groups, campaigns } from "@/db/schema";
import { resolveCompletedStages } from "@/lib/sends/stage-complete";
import {
  generateCampaignTrackingId,
  generateStageTrackingId,
} from "@/lib/tracking-id";
import {
  buildStageFullUrl,
  isGuideknLpUrl,
  STAGE_TRACKING_PARAM,
  setUrlParam,
} from "@/lib/stage-url";
import { loadStageUrlContext } from "@/lib/stage-url-context";

// Core of the behavioural-split endpoint, factored out of the route so it can be
// tested directly against a throwaway org (the route resolves org from the auth
// session, which a test harness can't pin). The route is a thin auth + error-map
// wrapper around this.
//
// ── CAMPAIGN-LEVEL (migration 0174) ──────────────────────────────────────────
// The split is now taken against the CAMPAIGN, not against one chosen stage. It
// stamps one lane-stage per SELECTED behavioural tier (0 ignored / 1 clicked /
// 2 reached offer / 3 registered — Phase 4), plus a
// `campaign_stage_split_groups` row that owns them.
//
// Tier 4 (purchased) gets no lane — those contacts exit the sequence.
//
// TWO THINGS ARE DELIBERATELY *NOT* DECIDED HERE:
//
//   1. The SOURCE SET. `source_stage_ids` stays empty and the group starts
//      'pending'; the set is resolved at RECOMPUTE time (T−15min via the
//      send-preflight cron, or lazily at Phase A). A stage that finishes sending
//      between this split being created and the recompute MUST be in the source
//      set, so freezing it now would be wrong.
//
//   2. The AUDIENCE. As before, a lane's recipients are resolved live at
//      materialization, not here.
//
// The ANCHOR is decided here, though: the latest completed stage by `sent_at`.
// It is the P4 slip anchor (the lanes wait for it to finish before firing) and
// it is the config template the selected lanes are cloned from. Each lane's
// `parent_stage_id` points at it too, so the existing P4 / lane-count /
// preflight code paths keep working unchanged.

// tier → human label for the lane's starting label. This is the REGISTRY of
// every lane a split can create — it is not the set that gets created. `tiers`
// on performBehavioralSplit filters it (see below).
//
// Tier 3 "Registered" joined in Phase 4 (migration 0184): someone who fired a $0
// registration on this campaign and has NOT purchased. It ranks above "Reached
// offer", so a registrant is NO LONGER in the tier-2 lane — if the operator does
// not tick Registered, those contacts get no message at this position. The
// confirm dialog says so next to the count.
//
// Tier 4 (purchased) is deliberately absent: a buyer EXITS the sequence, and
// migration 0184's CHECK refuses it at the database as well.
export const LANE_TIERS = [
  { tier: 0, label: "Ignored" },
  { tier: 1, label: "Clicked" },
  { tier: 2, label: "Reached offer" },
  { tier: 3, label: "Registered" },
] as const;

// Which lanes a split creates when the caller doesn't say.
//
// NOT all three, deliberately. Tier 0 ("Ignored") is a lane the operator does
// not want and deleted BY HAND after all but 4 of the first 77 splits — and when
// that manual delete was skipped on 2026-09-05 the leftover lane, never
// scheduled and never approved, could never materialize, so its group could
// never settle and the all-or-nothing release gate froze its two SCHEDULED
// siblings: 650 built messages stranded for ~13h across campaigns 1151/1152/1171
// while the drain was healthy. Creating only what the operator asked for is what
// removes that trap — see
// docs/superpowers/specs/2026-09-06-behavioural-split-lane-picker-design.md.
export const DEFAULT_LANE_TIERS: readonly number[] = [1, 2];

const VALID_LANE_TIERS = new Set(LANE_TIERS.map((t) => t.tier as number));

// Normalize the requested tiers: de-duplicate and sort ascending so lane
// stage_number assignment is deterministic regardless of tick order. Returns a
// refusal (never throws) so both the route and the direct test callers get the
// same codes.
export function resolveLaneTiers(
  tiers: number[] | undefined,
): { ok: true; tiers: number[] } | { ok: false; code: string; message: string } {
  if (tiers === undefined) return { ok: true, tiers: [...DEFAULT_LANE_TIERS] };
  const unique = [...new Set(tiers)].sort((a, b) => a - b);
  if (unique.length === 0) {
    return {
      ok: false,
      code: "no_lanes_selected",
      message: "Pick at least one behavioural lane to create.",
    };
  }
  const bad = unique.filter((t) => !VALID_LANE_TIERS.has(t));
  if (bad.length > 0) {
    return {
      ok: false,
      code: "invalid_lane_tier",
      // Derived from LANE_TIERS, not retyped: the list changed in Phase 4 and a
      // hard-coded "0, 1, 2" would have gone stale silently. Tier 4 (purchased)
      // exits the sequence and never gets a lane.
      message: `Not a behavioural lane tier: ${bad.join(", ")}. Valid tiers are ${LANE_TIERS.map((t) => t.tier).join(", ")}.`,
    };
  }
  return { ok: true, tiers: unique };
}

export type BehavioralSplitResult =
  | {
      ok: true;
      split_group_id: string;
      anchor_stage_id: number;
      source_stage_ids_preview: number[];
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
  // `actorUserId` stamps created_by_user_id on the lane children (migration
  // 0175). OPTIONAL because the test harnesses call this without a user, but a
  // lane created through the API must carry one: the deactivation kill switch
  // finds approved-but-unsent stages by author, and an unstamped lane child
  // would survive its creator's deactivation still armed to send.
  // `tiers` is which lanes to create (subset of LANE_TIERS' 0/1/2/3). Omitted ⇒
  // DEFAULT_LANE_TIERS. Validated here rather than only in the route so the
  // script harnesses that call this directly exercise the same rules.
  opts: {
    orgId: string;
    campaignId: number;
    actorUserId?: string | null;
    tiers?: number[];
  },
  database: typeof db = db,
): Promise<BehavioralSplitResult> {
  const { orgId, campaignId } = opts;

  // Refuse BEFORE any read or write — an invalid selection must not create a
  // group row, which would trip the campaign's own split_already_pending guard.
  const laneTiers = resolveLaneTiers(opts.tiers);
  if (!laneTiers.ok) {
    return {
      ok: false,
      status: 400,
      code: laneTiers.code,
      message: laneTiers.message,
      details: { field: "tiers" },
    };
  }
  const selectedTiers = new Set(laneTiers.tiers);

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

  // Gate: the split classifies contacts by how they behaved in stages that have
  // ALREADY SENT, so at least one completed stage is required. Uses the shared
  // pipeline definition (sent_at + no open rows) — NOT `status`, which is the
  // operator's manual record and disagrees with reality on 227 production stages.
  const completed = await resolveCompletedStages(database, campaignId, orgId);
  if (completed.length === 0) {
    return {
      ok: false,
      status: 409,
      code: "conflict",
      message:
        "This campaign has no completed stages yet — a behavioural split needs at least one stage that has finished sending.",
      details: { reason: "no_completed_stages" },
    };
  }
  // Latest completed by sent_at (resolveCompletedStages orders ascending).
  const anchor = completed[completed.length - 1];

  // Guard: refuse a second LIVE split while one is still un-fired. Once a group
  // reaches 'materialized' (its lanes have gone out) or 'failed', a fresh split is
  // allowed — that is the campaign-level analogue of the old "delete the lanes to
  // re-split" rule, and it lets an operator split again after more stages complete.
  const liveGroup = await database
    .select({ id: campaign_stage_split_groups.id, state: campaign_stage_split_groups.state })
    .from(campaign_stage_split_groups)
    .where(
      and(
        eq(campaign_stage_split_groups.campaign_id, campaignId),
        eq(campaign_stage_split_groups.org_id, orgId),
        sql`${campaign_stage_split_groups.state} IN ('pending', 'materializing')`,
        sql`EXISTS (
          SELECT 1 FROM campaign_stages s
          WHERE s.split_group_id = ${campaign_stage_split_groups.id}
            AND s.status <> 'archived'
        )`,
      ),
    )
    .limit(1);
  if (liveGroup[0]) {
    return {
      ok: false,
      status: 409,
      code: "conflict",
      message:
        "This campaign already has a behavioural split waiting to send. Let it fire, or archive its lanes, before creating another.",
      details: { reason: "split_already_pending", split_group_id: liveGroup[0].id },
    };
  }

  const source = await database
    .select()
    .from(campaign_stages)
    .where(
      and(
        eq(campaign_stages.id, anchor.id),
        eq(campaign_stages.campaign_id, campaignId),
        eq(campaign_stages.org_id, orgId),
        ne(campaign_stages.status, "archived"),
      ),
    )
    .limit(1)
    .then((r) => r[0]);
  if (!source) {
    return {
      ok: false,
      status: 409,
      code: "conflict",
      message: "The anchor stage could not be loaded — it may have been archived mid-request.",
      details: { reason: "anchor_unavailable", anchor_stage_id: anchor.id },
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

    // The group. state='pending' + empty source_stage_ids: the recompute owns
    // both (see the header note).
    const groupRows = await tx
      .insert(campaign_stage_split_groups)
      .values({
        org_id: orgId,
        campaign_id: campaignId,
        anchor_stage_id: anchor.id,
        state: "pending",
      })
      .returning({ id: campaign_stage_split_groups.id });
    const groupId = groupRows[0].id;

    // One lane per SELECTED tier. stage_number is auto-assigned by the BEFORE
    // INSERT trigger; send-state counters reset; split_index/split_total left NULL.
    type StageInsertable = Omit<
      typeof campaign_stages.$inferInsert,
      "stage_number"
    > & { stage_number?: number };
    const newRows: StageInsertable[] = LANE_TIERS.filter(({ tier }) =>
      selectedTiers.has(tier),
    ).map(({ tier, label }) => ({
      org_id: orgId,
      campaign_id: campaignId,
      label: `${baseLabel} — ${label} (tier ${tier})`,
      creative_id: source.creative_id,
      sms_provider_id: source.sms_provider_id,
      provider_phone_id: source.provider_phone_id,
      // 1b (0150): a copy carries the landing PAGE, not a frozen URL, so the
      // destination is rebuilt at mint time from ITS campaign's brand. Omitted
      // here until 2026-08-28, which left every lane of a behavioural split with NO
      // destination -- kickoff refused them with `no_destination` and the
      // operator had to re-pick the landing page by hand on each one. Only the
      // stage-duplicate path had it; the other three copy paths did not.
      landing_page_id: source.landing_page_id,
      sales_page_label: source.sales_page_label,
      short_url: source.short_url,
      full_url: source.full_url,
      utm_tag_ids: source.utm_tag_ids,
      stop_text: source.stop_text,
      include_clickers: source.include_clickers,
      exclude_clickers: source.exclude_clickers,
      include_no_status: source.include_no_status,
      // A lane NEVER inherits the anchor's send date — a stale (past) date would
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
      // The behavioural identity — set together, coherent with the CHECK.
      behavioral_tier: tier,
      parent_stage_id: anchor.id,
      split_group_id: groupId,
      created_by_user_id: opts.actorUserId ?? null,
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
      // Rebuild each lane's full_url CANONICALLY from its own tracking id for
      // guidekn (or empty/auto) sources — never inherit-and-patch a malformed
      // base. Custom non-guidekn URLs are preserved. Mirrors the A/B split route.
      const srcFull = (source.full_url ?? "").trim();
      const rebuildFromSalesPage = srcFull === "" || isGuideknLpUrl(srcFull);
      let salesPageUrl: string | null = null;
      if (rebuildFromSalesPage) {
        const ctx = await loadStageUrlContext({
          orgId,
          offerId: campaignRow[0].offer_id,
          salesPageLabel: source.sales_page_label,
          utmTagIds: [],
          dbc: tx,
        });
        if (ctx.ok) salesPageUrl = ctx.ctx.salesPageUrl;
      }
      for (const s of insertedStages) {
        if (s.creative_id == null) continue;
        const stageTrackingId = generateStageTrackingId({
          campaignTrackingId: parentTrackingId,
          stageNumber: s.stage_number,
          creativeId: s.creative_id,
        });
        let rewrittenFullUrl: string | null = s.full_url;
        if (rebuildFromSalesPage && salesPageUrl) {
          rewrittenFullUrl =
            buildStageFullUrl({ salesPageUrl, trackingId: stageTrackingId }) ||
            s.full_url;
        } else if (s.full_url) {
          rewrittenFullUrl = setUrlParam(
            s.full_url,
            STAGE_TRACKING_PARAM,
            stageTrackingId,
          );
        }
        await tx
          .update(campaign_stages)
          .set({ tracking_id: stageTrackingId, full_url: rewrittenFullUrl })
          // org_id alongside the id (CLAUDE.md §3). Cannot change the result:
          // every `s` is a row this same transaction INSERTed with
          // `org_id: orgId`, so the added predicate is true by construction —
          // it is here so the pattern holds by reading, not by provenance.
          .where(and(eq(campaign_stages.id, s.id), eq(campaign_stages.org_id, orgId)));
      }
    }

    return {
      ok: true as const,
      split_group_id: groupId,
      anchor_stage_id: anchor.id,
      // What the source set WOULD be if resolved right now. Shown in the confirm
      // dialog so the operator sees the scope; the authoritative set is written
      // by the recompute and may legitimately be larger by then.
      source_stage_ids_preview: completed.map((s) => s.id),
      lane_stage_ids: insertedStages.map((s) => s.id),
      tiers: insertedStages.map((s) => s.behavioral_tier),
    };
  });
}
