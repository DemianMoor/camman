import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  brands,
  campaign_stages,
  campaigns,
  contact_groups,
  offers,
  routing_types,
  traffic_types,
} from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { brandHasActiveShortDomain } from "@/lib/links/tracked-eligibility";
import { generateCampaignTrackingId } from "@/lib/tracking-id";
import {
  campaignUpdateSchema,
  nullIfEmpty,
} from "@/lib/validators/campaigns";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// String fields whose empty-string form should be coerced to NULL.
const NULLABLE_OPTIONAL_STRING = new Set(["human_id", "notes"]);
// Fields that aren't writable via PATCH (managed via dedicated routes).
const NON_UPDATABLE = new Set([
  "slug",
  "audience_snapshot_count",
  "previous_status",
  "status_changed_at",
  "created_by_user_id",
  "created_at",
  "archived_at",
  "save_as_draft",
  // tracking_id is system-generated and immutable; rejected upstream by
  // the validator with a TRACKING_ID_IMMUTABLE code, but listed here as
  // a backstop in case the validator changes.
  "tracking_id",
]);

export async function GET(
  _req: NextRequest,
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
    return apiError(400, "Invalid campaign id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  const rows = await db
    .select({
      id: campaigns.id,
      org_id: campaigns.org_id,
      slug: campaigns.slug,
      human_id: campaigns.human_id,
      name: campaigns.name,
      notes: campaigns.notes,
      brand_id: campaigns.brand_id,
      offer_id: campaigns.offer_id,
      routing_type_id: campaigns.routing_type_id,
      traffic_type_id: campaigns.traffic_type_id,
      assigned_to_user_id: campaigns.assigned_to_user_id,
      created_by_user_id: campaigns.created_by_user_id,
      audience_segment_ids: campaigns.audience_segment_ids,
      audience_contact_group_ids: campaigns.audience_contact_group_ids,
      audience_filters: campaigns.audience_filters,
      audience_snapshot_count: campaigns.audience_snapshot_count,
      audience_cap: campaigns.audience_cap,
      exclude_in_use_contacts: campaigns.exclude_in_use_contacts,
      start_date: campaigns.start_date,
      end_date: campaigns.end_date,
      status: campaigns.status,
      previous_status: campaigns.previous_status,
      status_changed_at: campaigns.status_changed_at,
      tracking_id: campaigns.tracking_id,
      link_mode: campaigns.link_mode,
      archived_at: campaigns.archived_at,
      created_at: campaigns.created_at,
      brand: {
        id: brands.id,
        name: brands.name,
        color: brands.color,
        // Brand's active short domain (for the tracked-mode SMS preview), via
        // subquery to keep the single-row shape. NULL when none is set.
        short_domain: drizzleSql<string | null>`(
          SELECT sd.domain FROM short_domains sd
          WHERE sd.brand_id = ${brands.id} AND sd.status = 'active'
          ORDER BY sd.created_at ASC, sd.id ASC LIMIT 1
        )`,
      },
      offer: {
        id: offers.id,
        name: offers.name,
        color: offers.color,
        sales_pages: offers.sales_pages,
        base_url: offers.base_url,
        postfix: offers.postfix,
      },
      routing_type: {
        id: routing_types.id,
        name: routing_types.name,
        color: routing_types.color,
      },
      traffic_type: {
        id: traffic_types.id,
        name: traffic_types.name,
        color: traffic_types.color,
      },
    })
    .from(campaigns)
    .leftJoin(brands, eq(brands.id, campaigns.brand_id))
    .leftJoin(offers, eq(offers.id, campaigns.offer_id))
    .leftJoin(routing_types, eq(routing_types.id, campaigns.routing_type_id))
    .leftJoin(traffic_types, eq(traffic_types.id, campaigns.traffic_type_id))
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.org_id, orgId)))
    .limit(1);

  if (!rows[0]) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "campaign",
    });
  }

  // Aggregate stage counts per status. One small query, easy to read.
  const stageStats = await db
    .select({
      status: campaign_stages.status,
      count: drizzleSql<number>`count(*)::int`,
    })
    .from(campaign_stages)
    .where(eq(campaign_stages.campaign_id, campaignId))
    .groupBy(campaign_stages.status);
  const stage_count_by_status: Record<string, number> = {};
  let stage_count_total = 0;
  for (const row of stageStats) {
    stage_count_by_status[row.status] = row.count;
    stage_count_total += row.count;
  }

  const r = rows[0];
  return NextResponse.json({
    ...r,
    brand: r.brand?.id ? r.brand : null,
    offer: r.offer?.id ? r.offer : null,
    routing_type: r.routing_type?.id ? r.routing_type : null,
    traffic_type: r.traffic_type?.id ? r.traffic_type : null,
    stage_count_total,
    stage_count_by_status,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.update")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId: cIdParam } = await params;
  const campaignId = parseId(cIdParam);
  if (campaignId === null) {
    return apiError(400, "Invalid campaign id", API_ERROR_CODES.VALIDATION, {
      field: "id",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = campaignUpdateSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    // params lives on custom-code issues only; the validator tags
    // tracking_id rejections with params.code = TRACKING_ID_IMMUTABLE.
    const isTrackingId =
      first?.code === "custom" &&
      (first.params as { code?: string } | undefined)?.code ===
        "TRACKING_ID_IMMUTABLE";
    return apiError(
      400,
      first?.message ?? "Invalid input",
      isTrackingId
        ? API_ERROR_CODES.TRACKING_ID_IMMUTABLE
        : API_ERROR_CODES.VALIDATION,
    );
  }
  const input = parsed.data;

  const current = await db
    .select({
      id: campaigns.id,
      status: campaigns.status,
      assigned_to_user_id: campaigns.assigned_to_user_id,
      brand_id: campaigns.brand_id,
      offer_id: campaigns.offer_id,
      tracking_id: campaigns.tracking_id,
      created_at: campaigns.created_at,
    })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.org_id, orgId)))
    .limit(1);
  if (!current[0]) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "campaign",
    });
  }
  if (current[0].status === "archived") {
    return apiError(
      409,
      "Archived campaigns can't be edited — restore first",
      API_ERROR_CODES.CONFLICT,
      { reason: "archived" },
    );
  }

  // Audience fields lock once the campaign leaves draft. The frozen pool
  // can't change after a campaign has been activated even once. Covers
  // segments, contact groups, filters, and the random-sample cap.
  if (
    current[0].status !== "draft" &&
    (input.audience_segment_ids !== undefined ||
      input.audience_contact_group_ids !== undefined ||
      input.audience_filters !== undefined ||
      input.audience_cap !== undefined ||
      input.exclude_in_use_contacts !== undefined)
  ) {
    return apiError(
      400,
      "Audience can't be modified after the campaign has been activated",
      API_ERROR_CODES.VALIDATION,
      { reason: "audience_locked_after_draft" },
    );
  }

  // Verify org ownership of contact_group_ids when present. Same pattern
  // as the create route — RLS isn't enough since Drizzle bypasses it.
  if (
    input.audience_contact_group_ids !== undefined &&
    input.audience_contact_group_ids.length > 0
  ) {
    const found = await db
      .select({ id: contact_groups.id })
      .from(contact_groups)
      .where(
        and(
          eq(contact_groups.org_id, orgId),
          inArray(contact_groups.id, input.audience_contact_group_ids),
        ),
      );
    if (found.length !== input.audience_contact_group_ids.length) {
      return apiError(
        400,
        "One or more audience_contact_group_ids don't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "audience_contact_group_ids" },
      );
    }
  }

  // Reassignment gate: changing assigned_to_user_id requires the
  // campaigns.reassign permission (manager+). We compare to the current
  // value so reassigning to the same value is a no-op that doesn't trip
  // the permission check.
  if (
    input.assigned_to_user_id !== undefined &&
    input.assigned_to_user_id !== current[0].assigned_to_user_id
  ) {
    if (!can(role, "campaigns.reassign")) {
      return apiError(
        403,
        "Reassigning a campaign requires the campaigns.reassign permission",
        API_ERROR_CODES.FORBIDDEN,
        { permission: "campaigns.reassign" },
      );
    }
  }

  // Guard the link_mode toggle: a campaign may only be set to 'tracked' when
  // its (resolved) brand has an active short_domain. Switching to 'manual' is
  // always allowed. Setting the mode never touches the manual short_url/
  // full_url fields — only which field the send path reads.
  if (input.link_mode === "tracked") {
    const resolvedBrandId =
      input.brand_id !== undefined
        ? input.brand_id ?? null
        : current[0].brand_id;
    if (resolvedBrandId == null) {
      return apiError(
        400,
        "Set a brand before enabling tracked links",
        API_ERROR_CODES.VALIDATION,
        { reason: "tracked_requires_brand" },
      );
    }
    if (!(await brandHasActiveShortDomain(orgId, resolvedBrandId))) {
      return apiError(
        400,
        "Add an active short domain for this brand before enabling tracked links",
        API_ERROR_CODES.VALIDATION,
        { reason: "tracked_requires_short_domain" },
      );
    }
  }

  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (NON_UPDATABLE.has(k)) continue;
    updates[k] = NULLABLE_OPTIONAL_STRING.has(k) ? nullIfEmpty(v as string) : v;
  }

  if (Object.keys(updates).length === 0) {
    return apiError(
      400,
      "No editable fields provided",
      API_ERROR_CODES.VALIDATION,
    );
  }

  try {
    // Compute whether this PATCH should also generate a tracking_id:
    // only when the campaign currently has none AND brand_id + offer_id
    // are both set after the update applies. We compare against the
    // existing values for any field not in the patch. The tracking_id
    // uses the campaign's ORIGINAL created_at (not "now") so the ID
    // reflects creation, not finalization.
    const resolvedBrandId =
      input.brand_id !== undefined ? input.brand_id ?? null : current[0].brand_id;
    const resolvedOfferId =
      input.offer_id !== undefined ? input.offer_id ?? null : current[0].offer_id;
    const needsTrackingId =
      current[0].tracking_id == null &&
      resolvedBrandId != null &&
      resolvedOfferId != null;

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(campaigns)
        .set(updates)
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.org_id, orgId)))
        .returning();
      if (!row) return null;

      if (needsTrackingId) {
        const trackingId = await generateCampaignTrackingId(tx, {
          orgId,
          brandId: resolvedBrandId as number,
          offerId: resolvedOfferId as number,
          createdAt: current[0].created_at,
        });
        const [withTracking] = await tx
          .update(campaigns)
          .set({ tracking_id: trackingId })
          .where(eq(campaigns.id, campaignId))
          .returning();
        return withTracking;
      }
      return row;
    });
    if (!updated) {
      return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "campaign",
      });
    }
    return NextResponse.json(updated);
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        "A campaign with this human_id already exists",
        API_ERROR_CODES.DUPLICATE,
        { field: "human_id" },
      );
    }
    throw err;
  }
}
