import { and, asc, desc, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  brands,
  campaign_stages,
  campaigns,
  creatives,
  offers,
  provider_phones,
  sms_providers,
} from "@/db/schema";
import {
  apiError,
  parseListParams,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import {
  computeStageAudienceCount,
  computeStageAudienceCountForDraft,
} from "@/lib/audience-snapshot";
import { can } from "@/lib/permissions";
import { buildStageFullUrl } from "@/lib/stage-url";
import { loadStageUrlContext } from "@/lib/stage-url-context";
import {
  generateCampaignTrackingId,
  generateStageTrackingId,
} from "@/lib/tracking-id";
import {
  nullIfEmpty,
  stageCreateSchema,
  STAGE_STATUSES,
} from "@/lib/validators/campaign-stages";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const SORT_COLUMNS = {
  stage_number: campaign_stages.stage_number,
  created_at: campaign_stages.created_at,
  status: campaign_stages.status,
} as const;

const VALID_STAGE_STATUSES = new Set<string>(STAGE_STATUSES);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "stages.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId } = await params;
  const cid = parseId(campaignId);
  if (cid === null) {
    return apiError(400, "Invalid campaign id", API_ERROR_CODES.VALIDATION, {
      field: "campaignId",
    });
  }

  // Pull the campaign's full audience config so the per-row audience
  // count below can switch to projected-mode computation when the
  // campaign is still a draft (pool not yet materialized).
  const campaignRow = await db
    .select({
      id: campaigns.id,
      status: campaigns.status,
      audience_segment_ids: campaigns.audience_segment_ids,
      audience_contact_group_ids: campaigns.audience_contact_group_ids,
      audience_filters: campaigns.audience_filters,
      audience_cap: campaigns.audience_cap,
      exclude_in_use_contacts: campaigns.exclude_in_use_contacts,
    })
    .from(campaigns)
    .where(and(eq(campaigns.id, cid), eq(campaigns.org_id, orgId)))
    .limit(1);
  if (!campaignRow[0]) {
    return apiError(404, "Campaign not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "campaign",
    });
  }
  const isDraft = campaignRow[0].status === "draft";
  const draftAudienceInput = {
    id: cid,
    orgId,
    segmentIds: campaignRow[0].audience_segment_ids ?? [],
    contactGroupIds: campaignRow[0].audience_contact_group_ids ?? [],
    filters: campaignRow[0].audience_filters ?? {},
    cap: campaignRow[0].audience_cap ?? null,
    excludeInUse: campaignRow[0].exclude_in_use_contacts,
  };

  const listParams = parseListParams(req);
  const sp = req.nextUrl.searchParams;
  const statusFilterRaw = sp.get("status");
  const statusFilter = statusFilterRaw
    ? statusFilterRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => VALID_STAGE_STATUSES.has(s))
    : [];

  const conditions = [
    eq(campaign_stages.campaign_id, cid),
    eq(campaign_stages.org_id, orgId),
  ];
  if (!listParams.showArchived && statusFilter.length === 0) {
    conditions.push(drizzleSql`${campaign_stages.status} <> 'archived'`);
  }
  if (statusFilter.length > 0) {
    conditions.push(inArray(campaign_stages.status, statusFilter));
  }
  const where = and(...conditions);

  // Stages list defaults to ascending stage_number — different from the
  // app-wide convention. parseListParams returns "desc" when sortDir is
  // absent (correct for newest-first lists), so we re-read the raw param
  // here and treat its absence as "asc".
  const sortKey = (listParams.sortBy ??
    "stage_number") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? campaign_stages.stage_number;
  const sortDirRaw = sp.get("sortDir");
  const orderFn = sortDirRaw === "desc" ? desc : asc;

  const rows = await db
    .select({
      id: campaign_stages.id,
      org_id: campaign_stages.org_id,
      campaign_id: campaign_stages.campaign_id,
      stage_number: campaign_stages.stage_number,
      label: campaign_stages.label,
      creative_id: campaign_stages.creative_id,
      sms_provider_id: campaign_stages.sms_provider_id,
      provider_phone_id: campaign_stages.provider_phone_id,
      sales_page_label: campaign_stages.sales_page_label,
      short_url: campaign_stages.short_url,
      full_url: campaign_stages.full_url,
      utm_tag_ids: campaign_stages.utm_tag_ids,
      stop_text: campaign_stages.stop_text,
      include_clickers: campaign_stages.include_clickers,
      exclude_clickers: campaign_stages.exclude_clickers,
      include_no_status: campaign_stages.include_no_status,
      scheduled_at: campaign_stages.scheduled_at,
      sent_at: campaign_stages.sent_at,
      status_changed_at: campaign_stages.status_changed_at,
      previous_status: campaign_stages.previous_status,
      status: campaign_stages.status,
      sms_count: campaign_stages.sms_count,
      total_cost: campaign_stages.total_cost,
      delivered_count: campaign_stages.delivered_count,
      opt_out_count: campaign_stages.opt_out_count,
      click_count: campaign_stages.click_count,
      late_click_count: campaign_stages.late_click_count,
      scrubbed_count: campaign_stages.scrubbed_count,
      bounced_count: campaign_stages.bounced_count,
      checkout_click_count: campaign_stages.checkout_click_count,
      sales_count: campaign_stages.sales_count,
      sales_payout_each: campaign_stages.sales_payout_each,
      notes: campaign_stages.notes,
      tracking_id: campaign_stages.tracking_id,
      split_index: campaign_stages.split_index,
      split_total: campaign_stages.split_total,
      archived_at: campaign_stages.archived_at,
      created_at: campaign_stages.created_at,
      creative: {
        id: creatives.id,
        slug: creatives.slug,
        text: creatives.text,
      },
      provider: {
        id: sms_providers.id,
        name: sms_providers.name,
        color: sms_providers.color,
      },
      provider_phone: {
        id: provider_phones.id,
        phone_number: provider_phones.phone_number,
      },
      brand: { id: brands.id, name: brands.name, color: brands.color },
      offer: {
        id: offers.id,
        name: offers.name,
        color: offers.color,
        payout_cpa: offers.payout_cpa,
      },
    })
    .from(campaign_stages)
    .leftJoin(creatives, eq(creatives.id, campaign_stages.creative_id))
    .leftJoin(
      sms_providers,
      eq(sms_providers.id, campaign_stages.sms_provider_id),
    )
    .leftJoin(
      provider_phones,
      eq(provider_phones.id, campaign_stages.provider_phone_id),
    )
    .leftJoin(campaigns, eq(campaigns.id, campaign_stages.campaign_id))
    .leftJoin(brands, eq(brands.id, campaigns.brand_id))
    .leftJoin(offers, eq(offers.id, campaigns.offer_id))
    .where(where)
    .orderBy(orderFn(sortColumn));

  // TODO: audience_count is computed per-stage via one query each. Fine for
  // typical campaigns (≤12 stages); may need optimization for campaigns
  // with many stages — consider materializing on stage-status-change in a
  // later step, or batching all stages into a single query with FILTERs.
  const audienceCounts = await Promise.all(
    rows.map((r) =>
      (isDraft
        ? computeStageAudienceCountForDraft(draftAudienceInput, {
            include_no_status: r.include_no_status,
            include_clickers: r.include_clickers,
            exclude_clickers: r.exclude_clickers,
            split_index: r.split_index,
            split_total: r.split_total,
          })
        : computeStageAudienceCount(cid, orgId, {
            include_no_status: r.include_no_status,
            include_clickers: r.include_clickers,
            exclude_clickers: r.exclude_clickers,
            split_index: r.split_index,
            split_total: r.split_total,
          })
      ).then((res) => res.count),
    ),
  );

  let data = rows.map((r, i) => ({
    ...r,
    creative: r.creative?.id ? r.creative : null,
    provider: r.provider?.id ? r.provider : null,
    provider_phone: r.provider_phone?.id ? r.provider_phone : null,
    brand: r.brand?.id ? r.brand : null,
    offer: r.offer?.id ? r.offer : null,
    audience_count: audienceCounts[i],
  }));

  // audience_count is derived in JS post-query; sort it here when the
  // client asks for it. SQL-side ordering is handled above for the
  // built-in columns.
  if (listParams.sortBy === "audience_count") {
    const dir = sortDirRaw === "desc" ? -1 : 1;
    data = [...data].sort(
      (a, b) => dir * (a.audience_count - b.audience_count),
    );
  }

  return NextResponse.json({ data, totalCount: data.length });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "stages.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId } = await params;
  const cid = parseId(campaignId);
  if (cid === null) {
    return apiError(400, "Invalid campaign id", API_ERROR_CODES.VALIDATION, {
      field: "campaignId",
    });
  }

  const campaignRow = await db
    .select({
      id: campaigns.id,
      status: campaigns.status,
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

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = stageCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const input = parsed.data;

  // FK ownership for the optional references.
  if (input.creative_id != null) {
    const r = await db
      .select({ id: creatives.id })
      .from(creatives)
      .where(and(eq(creatives.id, input.creative_id), eq(creatives.org_id, orgId)))
      .limit(1);
    if (!r[0]) {
      return apiError(
        400,
        "creative_id doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "creative_id" },
      );
    }
  }
  if (input.sms_provider_id != null) {
    const r = await db
      .select({ id: sms_providers.id })
      .from(sms_providers)
      .where(
        and(
          eq(sms_providers.id, input.sms_provider_id),
          eq(sms_providers.org_id, orgId),
        ),
      )
      .limit(1);
    if (!r[0]) {
      return apiError(
        400,
        "sms_provider_id doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "sms_provider_id" },
      );
    }
  }
  if (input.provider_phone_id != null) {
    const r = await db
      .select({ id: provider_phones.id })
      .from(provider_phones)
      .where(
        and(
          eq(provider_phones.id, input.provider_phone_id),
          eq(provider_phones.org_id, orgId),
        ),
      )
      .limit(1);
    if (!r[0]) {
      return apiError(
        400,
        "provider_phone_id doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "provider_phone_id" },
      );
    }
  }

  // Resolve the Full URL build context (offer base_url/postfix, sales page
  // URL, selected UTM tags) — also the FK ownership check for utm_tag_ids.
  const utmTagIds = input.utm_tag_ids ?? [];
  const fullUrlAuto = input.full_url_auto === true;
  const urlCtxResult = await loadStageUrlContext({
    orgId,
    offerId: campaignRow[0].offer_id,
    salesPageLabel: nullIfEmpty(input.sales_page_label),
    utmTagIds,
  });
  if (!urlCtxResult.ok) {
    return apiError(
      400,
      "A selected UTM tag doesn't belong to your organization",
      API_ERROR_CODES.VALIDATION,
      { field: "utm_tag_ids" },
    );
  }
  const urlCtx = urlCtxResult.ctx;

  // stage_number is auto-assigned by the BEFORE INSERT trigger; we pass
  // undefined and let the trigger fill it in. The TS shape requires the
  // field, so we cast.
  type StageInsertable = Omit<
    typeof campaign_stages.$inferInsert,
    "stage_number"
  > & { stage_number?: number };
  const values: StageInsertable = {
    org_id: orgId,
    campaign_id: cid,
    label: nullIfEmpty(input.label),
    creative_id: input.creative_id ?? null,
    sms_provider_id: input.sms_provider_id ?? null,
    provider_phone_id: input.provider_phone_id ?? null,
    sales_page_label: nullIfEmpty(input.sales_page_label),
    short_url: nullIfEmpty(input.short_url),
    // When full_url_auto, full_url is (re)built in the transaction below
    // once the real stage tracking ID is known; insert null as a
    // placeholder. Otherwise store the client's value verbatim.
    full_url: fullUrlAuto ? null : nullIfEmpty(input.full_url),
    utm_tag_ids: utmTagIds,
    stop_text: input.stop_text,
    include_clickers: input.include_clickers,
    exclude_clickers: input.exclude_clickers,
    include_no_status: input.include_no_status,
    scheduled_at: input.scheduled_at ? new Date(input.scheduled_at) : null,
    notes: nullIfEmpty(input.notes),
    status: "draft",
  };

  // Stage insert + (conditional) campaign-tracking-id backfill + stage
  // tracking_id generation all run in one transaction so a failure at any
  // point leaves no partial state. The stage's tracking_id requires the
  // parent campaign to have a tracking_id AND the stage to have a
  // creative_id; both NULLs are tolerated for drafts.
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(campaign_stages)
      .values(values as typeof campaign_stages.$inferInsert)
      .returning();

    let parentTrackingId = campaignRow[0].tracking_id;
    if (
      parentTrackingId == null &&
      campaignRow[0].brand_id != null &&
      campaignRow[0].offer_id != null
    ) {
      // Pre-Phase-9 campaigns (created before tracking_id existed) and
      // drafts that were upgraded out-of-band may lack a tracking_id even
      // though brand+offer are set. Generate it now so the stage can
      // reference it.
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

    const setOnUpdate: Partial<typeof campaign_stages.$inferInsert> = {};
    let stageTrackingId: string | null = null;
    if (parentTrackingId != null && row.creative_id != null) {
      stageTrackingId = generateStageTrackingId({
        campaignTrackingId: parentTrackingId,
        stageNumber: row.stage_number,
        creativeId: row.creative_id,
      });
      setOnUpdate.tracking_id = stageTrackingId;
    }
    // Auto full_url is the BARE sales-page URL — tracking ID and UTM params
    // are attached manually in the form (stored verbatim once edited).
    if (fullUrlAuto) {
      setOnUpdate.full_url =
        buildStageFullUrl({ salesPageUrl: urlCtx.salesPageUrl }) || null;
    }

    if (Object.keys(setOnUpdate).length > 0) {
      const [withUpdates] = await tx
        .update(campaign_stages)
        .set(setOnUpdate)
        .where(eq(campaign_stages.id, row.id))
        .returning();
      return withUpdates;
    }

    return row;
  });

  return NextResponse.json(created, { status: 201 });
}
