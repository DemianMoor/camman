import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { campaign_stages, campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
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
import { liveSplitPartnerCount } from "@/lib/stages/split-membership";

// Split a stage into N siblings for A/B testing. The source stage is
// repurposed as split 1 of N; (N-1) new stages clone its configuration
// and become splits 2..N. Each stage's audience query then partitions
// the campaign's frozen pool by
// `mod(hashtext(contact_id::text), N) = split_index - 1`, so contacts
// land deterministically in exactly one bucket.
//
// Behavior:
//   - Source stage must not already be part of a split (split_total IS NULL).
//   - count must be between 2 and 10 (UI offers 2–5; capped here for the
//     direct-API path).
//   - Each new stage inherits the source's content (label suffixed, creative,
//     filters, URLs, etc.) with send-state counters reset to draft zero.
//   - Tracking IDs regenerate per new stage (new stage_number, new tracking_id).
//   - All writes inside one transaction so a failure leaves the source
//     untouched.

const SPLIT_MAX = 10;

function parseId(idParam: string): number | null {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const splitSchema = z.object({
  count: z
    .number()
    .int()
    .min(2, "Split must produce at least 2 stages")
    .max(SPLIT_MAX, `Split must produce at most ${SPLIT_MAX} stages`),
});

export async function POST(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ campaignId: string; stageId: string }> },
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

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = splitSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const count = parsed.data.count;

  // Pre-check the parent campaign + the source stage in two cheap reads
  // before opening the transaction. Both writes go in the transaction
  // below; the reads here just enable better error messages.
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
  if (source.split_total !== null) {
    // Only block if LIVE (non-archived) variants still exist. Once the extra
    // variants are archived or deleted, the source stands alone and re-splitting
    // it is safe — the transaction below overwrites its split_index/split_total.
    const partners = await liveSplitPartnerCount(db, {
      orgId,
      campaignId: cid,
      stageId: sid,
    });
    if (partners > 0) {
      return apiError(
        409,
        "This stage is already split into active variants. Archive or delete the other variants first.",
        API_ERROR_CODES.CONFLICT,
        { reason: "already_split", split_total: source.split_total },
      );
    }
  }
  if (source.status === "archived") {
    return apiError(
      409,
      "Archived stages can't be split. Restore the stage first.",
      API_ERROR_CODES.CONFLICT,
      { reason: "archived" },
    );
  }

  const baseLabel = source.label ?? `Stage ${source.stage_number}`;

  const result = await db.transaction(async (tx) => {
    // Backfill the parent campaign's tracking_id if it's missing but
    // brand+offer exist — mirrors the stage POST + duplicate paths.
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

    // Source stage becomes split 1 of N. Its tracking_id stays — the
    // creative_id and stage_number didn't change, so the historical
    // reference is preserved.
    await tx
      .update(campaign_stages)
      .set({
        split_index: 1,
        split_total: count,
        label: `${baseLabel} (A)`,
      })
      .where(eq(campaign_stages.id, source.id));

    // Letters A, B, C, … for human-readable labels on the new siblings.
    // Falls back to numeric suffixes past Z.
    function suffixFor(i: number): string {
      if (i < 26) return String.fromCharCode(65 + i);
      return `#${i + 1}`;
    }

    // Build the N-1 new sibling rows. stage_number is auto-assigned by
    // the BEFORE INSERT trigger; the trigger gives them sequential
    // numbers after the source. Send-state counters reset.
    type StageInsertable = Omit<
      typeof campaign_stages.$inferInsert,
      "stage_number"
    > & { stage_number?: number };
    const newRows: StageInsertable[] = [];
    for (let i = 1; i < count; i++) {
      newRows.push({
        org_id: orgId,
        campaign_id: cid,
        label: `${baseLabel} (${suffixFor(i)})`,
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
        // A split sibling NEVER inherits the parent's send date — a stale (past)
        // date would auto-fire on approval. Each variant gets a fresh date; the
        // send pipeline refuses a null-scheduled stage (no_schedule).
        scheduled_at: null,
        notes: source.notes,
        status: "draft",
        sms_count: 0,
        total_cost: "0",
        delivered_count: 0,
        opt_out_count: 0,
        click_count: 0,
        split_index: i + 1,
        split_total: count,
      });
    }

    const insertedStages = await tx
      .insert(campaign_stages)
      .values(newRows as typeof campaign_stages.$inferInsert[])
      .returning({
        id: campaign_stages.id,
        stage_number: campaign_stages.stage_number,
        creative_id: campaign_stages.creative_id,
        full_url: campaign_stages.full_url,
      });

    // Each new sibling gets its own tracking_id. Skip stages without a
    // creative_id (mirrors stage POST behavior).
    if (parentTrackingId != null) {
      // For guidekn (or empty/auto) sources, rebuild each sibling's full_url
      // CANONICALLY from its OWN tracking id (…/lp/<slug>?sub_id3=<id>) instead
      // of inheriting the source's URL and patching sub_id3 — the old approach
      // propagated a malformed base (id-in-path) verbatim. Custom non-guidekn
      // URLs are preserved (best-effort sub_id3 rewrite). Resolve the source's
      // sales page ONCE; all siblings share it.
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
          .where(eq(campaign_stages.id, s.id));
      }
    }

    return {
      source_id: source.id,
      new_stage_ids: insertedStages.map((s) => s.id),
      split_total: count,
    };
  });

  return NextResponse.json(result, { status: 201 });
}
