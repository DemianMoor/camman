import { format } from "date-fns";
import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  brands,
  campaigns,
  contact_groups,
  offers,
  routing_types,
  segments,
  traffic_types,
} from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { snapshotAudience } from "@/lib/audience-snapshot";
import { logCampaignEvent } from "@/lib/campaign-events";
import { generateCampaignSlug } from "@/lib/campaign-helpers";
import { brandHasActiveShortDomain } from "@/lib/links/tracked-eligibility";
import { can } from "@/lib/permissions";
import { generateCampaignTrackingId } from "@/lib/tracking-id";
import {
  campaignCreateSchema,
  nullIfEmpty,
} from "@/lib/validators/campaigns";

const SLUG_RETRY_LIMIT = 5;

// Launch-on-create snapshots the audience pool, which at scale (100K+
// candidate contacts) legitimately takes several seconds. Raise the limit
// above Vercel's default so a large snapshot isn't cut off mid-transaction.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "campaigns.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = campaignCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const input = parsed.data;
  const saveAsDraft = input.save_as_draft === true;

  // For draft saves, the only certain field is `name`. For launches, the
  // full create-time set was already validated by the schema.

  // Verify FK ownership for any IDs that are present.
  if (input.brand_id != null) {
    const r = await db
      .select({ id: brands.id })
      .from(brands)
      .where(and(eq(brands.id, input.brand_id), eq(brands.org_id, orgId)))
      .limit(1);
    if (!r[0]) {
      return apiError(
        400,
        "brand_id doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "brand_id" },
      );
    }
  }
  // API Send (tracked) requires the brand to have an active short domain —
  // same guard as the PATCH toggle, applied here so create can't make a
  // tracked campaign that can't mint links.
  if (input.link_mode === "tracked") {
    if (input.brand_id == null) {
      return apiError(
        400,
        "Set a brand before enabling API Send",
        API_ERROR_CODES.VALIDATION,
        { reason: "tracked_requires_brand" },
      );
    }
    if (!(await brandHasActiveShortDomain(orgId, input.brand_id))) {
      return apiError(
        400,
        "Add an active short domain for this brand before enabling API Send",
        API_ERROR_CODES.VALIDATION,
        { reason: "tracked_requires_short_domain" },
      );
    }
  }
  if (input.offer_id != null) {
    const r = await db
      .select({ id: offers.id })
      .from(offers)
      .where(and(eq(offers.id, input.offer_id), eq(offers.org_id, orgId)))
      .limit(1);
    if (!r[0]) {
      return apiError(
        400,
        "offer_id doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "offer_id" },
      );
    }
  }
  if (input.routing_type_id != null) {
    const r = await db
      .select({ id: routing_types.id })
      .from(routing_types)
      .where(
        and(
          eq(routing_types.id, input.routing_type_id),
          eq(routing_types.org_id, orgId),
        ),
      )
      .limit(1);
    if (!r[0]) {
      return apiError(
        400,
        "routing_type_id doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "routing_type_id" },
      );
    }
  }
  if (input.traffic_type_id != null) {
    const r = await db
      .select({ id: traffic_types.id })
      .from(traffic_types)
      .where(
        and(
          eq(traffic_types.id, input.traffic_type_id),
          eq(traffic_types.org_id, orgId),
        ),
      )
      .limit(1);
    if (!r[0]) {
      return apiError(
        400,
        "traffic_type_id doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "traffic_type_id" },
      );
    }
  }
  const segmentIds = input.audience_segment_ids ?? [];
  const excludeSegmentIds = input.audience_exclude_segment_ids ?? [];
  const contactGroupIds = input.audience_contact_group_ids ?? [];
  // Verify ownership over the union of include + exclude segments in one query.
  const allSegmentIds = Array.from(
    new Set([...segmentIds, ...excludeSegmentIds]),
  );
  if (allSegmentIds.length > 0) {
    const found = await db
      .select({ id: segments.id })
      .from(segments)
      .where(
        and(eq(segments.org_id, orgId), inArray(segments.id, allSegmentIds)),
      );
    if (found.length !== allSegmentIds.length) {
      return apiError(
        400,
        "One or more audience_segment_ids don't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "audience_segment_ids" },
      );
    }
  }
  if (contactGroupIds.length > 0) {
    const found = await db
      .select({ id: contact_groups.id })
      .from(contact_groups)
      .where(
        and(
          eq(contact_groups.org_id, orgId),
          inArray(contact_groups.id, contactGroupIds),
        ),
      );
    if (found.length !== contactGroupIds.length) {
      return apiError(
        400,
        "One or more audience_contact_group_ids don't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "audience_contact_group_ids" },
      );
    }
  }

  const filters = input.audience_filters ?? {};
  const audienceCap = input.audience_cap ?? null;
  // Default true (on) when the form omits it — matches the DB column default.
  const excludeInUse = input.exclude_in_use_contacts ?? true;
  // Default false — offer-level exclusion is opt-in (matches the DB default).
  const excludePriorOffer = input.exclude_prior_offer_contacts ?? false;

  // Auto-generate a name for empty drafts so the list page has something
  // to render. The pattern is intentionally readable so an operator can
  // identify their own drafts at a glance.
  const trimmedName = input.name?.trim() ?? "";
  const resolvedName =
    trimmedName.length > 0
      ? trimmedName
      : saveAsDraft
        ? format(new Date(), "'Draft - 'yyyy-MM-dd HH:mm")
        : null; // shouldn't happen — validator rejects empty name on launch

  // Transaction: insert campaign, snapshot audience (launch path only),
  // update count. Drafts skip the snapshot entirely — it'll be computed
  // at activation time. If the audience is empty for a launch, roll back
  // the whole transaction.
  for (let attempt = 0; attempt < SLUG_RETRY_LIMIT; attempt++) {
    try {
      const result = await db.transaction(async (tx) => {
        const slug = generateCampaignSlug();
        const [inserted] = await tx
          .insert(campaigns)
          .values({
            org_id: orgId,
            slug,
            human_id: nullIfEmpty(input.human_id),
            name: resolvedName,
            notes: nullIfEmpty(input.notes),
            brand_id: input.brand_id ?? null,
            offer_id: input.offer_id ?? null,
            routing_type_id: input.routing_type_id ?? null,
            traffic_type_id: input.traffic_type_id ?? null,
            assigned_to_user_id: input.assigned_to_user_id ?? user.id,
            created_by_user_id: user.id,
            audience_segment_ids: segmentIds,
            audience_exclude_segment_ids: excludeSegmentIds,
            audience_contact_group_ids: contactGroupIds,
            audience_filters: filters,
            audience_snapshot_count: 0,
            audience_cap: audienceCap,
            exclude_in_use_contacts: excludeInUse,
            exclude_prior_offer_contacts: excludePriorOffer,
            link_mode: input.link_mode ?? "manual",
            start_date: input.start_date ?? null,
            end_date: input.end_date ?? null,
            status: "draft",
          })
          .returning();

        // Generate the tracking_id in the same transaction so a rolled-back
        // campaign creation doesn't burn a sequence number. Skipped when
        // brand or offer aren't set yet (typical for drafts) — backfilled
        // by PATCH once both are filled in.
        let trackingId: string | null = null;
        if (inserted.brand_id != null && inserted.offer_id != null) {
          trackingId = await generateCampaignTrackingId(tx, {
            orgId,
            brandId: inserted.brand_id,
            offerId: inserted.offer_id,
            createdAt: inserted.created_at,
          });
          await tx
            .update(campaigns)
            .set({ tracking_id: trackingId })
            .where(eq(campaigns.id, inserted.id));
        }

        if (!saveAsDraft) {
          // Launch path: the validator guarantees segments.length >= 1
          // OR contact_group_ids.length >= 1.
          const snap = await snapshotAudience(
            {
              campaignId: inserted.id,
              orgId,
              segmentIds,
              excludeSegmentIds,
              contactGroupIds,
              filters,
              cap: audienceCap,
              excludeInUse,
              // Bake the prior-offer exclusion into the frozen pool so the pool
              // equals the previewed will-send (no surprise re-filter at send).
              excludePriorOffer,
              offerId: inserted.offer_id,
            },
            tx,
          );
          if (snap.count === 0) {
            // Trigger rollback — caller maps to a 400.
            throw new EmptyAudienceError();
          }
          const [updated] = await tx
            .update(campaigns)
            .set({
              audience_snapshot_count: snap.count,
              status: "active",
              previous_status: "draft",
              status_changed_at: drizzleSql`now()`,
            })
            .where(eq(campaigns.id, inserted.id))
            .returning();
          await logCampaignEvent(tx, {
            orgId,
            campaignId: inserted.id,
            actorUserId: user.id,
            eventType: "campaign_created",
            summary: `Created and activated campaign “${updated.name}”`,
            metadata: { status: "active", audience_count: snap.count },
          });
          return updated;
        }

        await logCampaignEvent(tx, {
          orgId,
          campaignId: inserted.id,
          actorUserId: user.id,
          eventType: "campaign_created",
          summary: `Created campaign “${inserted.name}” as draft`,
          metadata: { status: "draft" },
        });
        return { ...inserted, tracking_id: trackingId };
      });
      return NextResponse.json(result, { status: 201 });
    } catch (err) {
      if (err instanceof EmptyAudienceError) {
        return apiError(
          400,
          "The current filters yield zero contacts in the chosen segments",
          API_ERROR_CODES.VALIDATION,
          { reason: "empty_audience" },
        );
      }
      if (!isUniqueViolation(err)) throw err;
      // Could be slug or human_id. If human_id is provided and the conflict
      // persists across retries it's the user's input; surface as 409 below.
    }
  }
  return apiError(
    409,
    "A campaign with this human_id already exists",
    API_ERROR_CODES.DUPLICATE,
    { field: "human_id" },
  );
}

class EmptyAudienceError extends Error {
  constructor() {
    super("empty audience");
    this.name = "EmptyAudienceError";
  }
}
