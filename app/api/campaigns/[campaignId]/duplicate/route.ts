import { and, asc, eq, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { campaign_stages, campaigns } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { generateCampaignSlug } from "@/lib/campaign-helpers";
import { can } from "@/lib/permissions";
import {
  generateCampaignTrackingId,
  generateStageTrackingId,
} from "@/lib/tracking-id";
import { STAGE_TRACKING_PARAM, setUrlParam } from "@/lib/stage-url";

const SLUG_RETRY_LIMIT = 5;

function parseId(idParam: string): number | null {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Duplicate a campaign as a fresh draft. Same metadata + audience config
// as the source, new slug, name suffixed with " (copy)", status reset to
// 'draft', human_id cleared (would conflict). Optional include_stages
// clones all non-archived stages with their config — send-state counters
// and statuses reset to draft.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "campaigns.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId } = await params;
  const cid = parseId(campaignId);
  if (cid === null) {
    return apiError(400, "Invalid campaign id", API_ERROR_CODES.VALIDATION, {
      field: "campaignId",
    });
  }

  let body: { include_stages?: unknown } = {};
  try {
    const raw = await req.text();
    if (raw.trim().length > 0) {
      body = JSON.parse(raw);
    }
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const includeStages = body.include_stages === true;

  // Read source campaign
  const sourceRow = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, cid), eq(campaigns.org_id, orgId)))
    .limit(1);
  if (!sourceRow[0]) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "campaign",
    });
  }
  const source = sourceRow[0];

  // Source stages (if cloning). Archived stages are excluded — copying
  // them into a brand-new draft would be confusing.
  const sourceStages = includeStages
    ? await db
        .select()
        .from(campaign_stages)
        .where(
          and(
            eq(campaign_stages.campaign_id, cid),
            eq(campaign_stages.org_id, orgId),
            drizzleSql`${campaign_stages.status} <> 'archived'`,
          ),
        )
        .orderBy(asc(campaign_stages.stage_number))
    : [];

  const baseName = (source.name ?? "Untitled").replace(/\s+\(copy\)$/i, "");
  const newName = `${baseName} (copy)`;

  for (let attempt = 0; attempt < SLUG_RETRY_LIMIT; attempt++) {
    try {
      const result = await db.transaction(async (tx) => {
        const slug = generateCampaignSlug();
        const [inserted] = await tx
          .insert(campaigns)
          .values({
            org_id: orgId,
            slug,
            // Don't copy human_id — it's globally unique per org and the
            // source still has it.
            human_id: null,
            name: newName,
            notes: source.notes,
            brand_id: source.brand_id,
            offer_id: source.offer_id,
            routing_type_id: source.routing_type_id,
            traffic_type_id: source.traffic_type_id,
            assigned_to_user_id: source.assigned_to_user_id ?? user.id,
            created_by_user_id: user.id,
            audience_segment_ids: source.audience_segment_ids,
            audience_exclude_segment_ids: source.audience_exclude_segment_ids,
            audience_contact_group_ids: source.audience_contact_group_ids,
            audience_filters: source.audience_filters,
            audience_snapshot_count: 0,
            audience_cap: source.audience_cap,
            exclude_in_use_contacts: source.exclude_in_use_contacts,
            start_date: source.start_date,
            end_date: source.end_date,
            status: "draft",
          })
          .returning();

        // Generate the cloned campaign's own tracking_id (separate
        // sequence number from the source — its tracking_id stays put).
        // Skipped when brand or offer aren't set on the source.
        let parentTrackingId: string | null = null;
        if (inserted.brand_id != null && inserted.offer_id != null) {
          parentTrackingId = await generateCampaignTrackingId(tx, {
            orgId,
            brandId: inserted.brand_id,
            offerId: inserted.offer_id,
            createdAt: inserted.created_at,
          });
          await tx
            .update(campaigns)
            .set({ tracking_id: parentTrackingId })
            .where(eq(campaigns.id, inserted.id));
        }

        if (sourceStages.length > 0) {
          // Reset send-state on every cloned stage. stage_number is
          // auto-assigned by the BEFORE INSERT trigger; the Drizzle type
          // requires the field so we cast like other stage-insert callers.
          type StageInsertable = Omit<
            typeof campaign_stages.$inferInsert,
            "stage_number"
          > & { stage_number?: number };
          const rowsToInsert: StageInsertable[] = sourceStages.map((s) => ({
            org_id: orgId,
            campaign_id: inserted.id,
            label: s.label,
            creative_id: s.creative_id,
            sms_provider_id: s.sms_provider_id,
            provider_phone_id: s.provider_phone_id,
            sales_page_label: s.sales_page_label,
            short_url: s.short_url,
            full_url: s.full_url,
            stop_text: s.stop_text,
            include_clickers: s.include_clickers,
            exclude_clickers: s.exclude_clickers,
            include_no_status: s.include_no_status,
            // A cloned stage NEVER inherits the parent's send date — a stale
            // (past) date would auto-fire on approval. Operator sets a fresh
            // date; the send pipeline refuses a null-scheduled stage.
            scheduled_at: null,
            notes: s.notes,
            status: "draft" as const,
            sms_count: 0,
            total_cost: "0",
            delivered_count: 0,
            opt_out_count: 0,
            click_count: 0,
          }));
          const insertedStages = await tx
            .insert(campaign_stages)
            .values(rowsToInsert as typeof campaign_stages.$inferInsert[])
            .returning({
              id: campaign_stages.id,
              stage_number: campaign_stages.stage_number,
              creative_id: campaign_stages.creative_id,
              full_url: campaign_stages.full_url,
            });

          // Generate per-stage tracking_ids using the freshly-allocated
          // parent tracking_id + each row's auto-assigned stage_number.
          // Skip stages without a creative_id (per the stage POST route).
          if (parentTrackingId != null) {
            for (const s of insertedStages) {
              if (s.creative_id == null) continue;
              const stageTrackingId = generateStageTrackingId({
                campaignTrackingId: parentTrackingId,
                stageNumber: s.stage_number,
                creativeId: s.creative_id,
              });
              // Rewrite ONLY sub_id3 in the cloned URL to this stage's own
              // tracking ID, preserving all other params (each clone keeps its
              // own source URL). No URL ⇒ nothing to rewrite.
              const rewrittenFullUrl = s.full_url
                ? setUrlParam(s.full_url, STAGE_TRACKING_PARAM, stageTrackingId)
                : s.full_url;
              await tx
                .update(campaign_stages)
                .set({ tracking_id: stageTrackingId, full_url: rewrittenFullUrl })
                .where(eq(campaign_stages.id, s.id));
            }
          }
        }

        return { ...inserted, tracking_id: parentTrackingId };
      });
      return NextResponse.json(result, { status: 201 });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Slug collision; retry. human_id is always null on duplicate so the
      // only conflict source is slug.
    }
  }
  return apiError(
    409,
    "Could not generate a unique slug after multiple attempts",
    API_ERROR_CODES.DUPLICATE,
    { field: "slug" },
  );
}
