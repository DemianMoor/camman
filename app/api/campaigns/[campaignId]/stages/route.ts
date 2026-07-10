import { and, asc, desc, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  brands,
  campaign_stages,
  campaigns,
  creatives,
  keitaro_stage_results,
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
  computeStageAudienceCountsBatch,
  computeStageAudienceCountsBatchForDraft,
} from "@/lib/audience-snapshot";
import { logCampaignEvent } from "@/lib/campaign-events";
import { can } from "@/lib/permissions";
import { isScheduledAtInPast } from "@/lib/sends/schedule-guard";
import { buildStageFullUrl, validateDestination } from "@/lib/stage-url";
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

// The GET batches all non-lane stage audience counts into one query. Behavioral
// lanes (the expensive live-tier scan) are deferred to GET .../stages/lane-counts
// so they don't block first paint. This handler stays well under 10s, but the
// frozen-pool scan earns headroom above Vercel's 10s default so it degrades to
// "slow" rather than a hard timeout under load.
export const maxDuration = 30;

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
      link_mode: campaigns.link_mode,
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
  const linkMode = campaignRow[0].link_mode;
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
      materialized_at: campaign_stages.materialized_at,
      schedule_missed_at: campaign_stages.schedule_missed_at,
      send_approved: campaign_stages.send_approved,
      status_changed_at: campaign_stages.status_changed_at,
      previous_status: campaign_stages.previous_status,
      status: campaign_stages.status,
      sms_count: campaign_stages.sms_count,
      total_cost: campaign_stages.total_cost,
      total_cost_manual: campaign_stages.total_cost_manual,
      delivered_count: campaign_stages.delivered_count,
      opt_out_count: campaign_stages.opt_out_count,
      inbound_opt_out_count: campaign_stages.inbound_opt_out_count,
      click_count: campaign_stages.click_count,
      scrubbed_count: campaign_stages.scrubbed_count,
      bounced_count: campaign_stages.bounced_count,
      checkout_click_count: campaign_stages.checkout_click_count,
      sales_count: campaign_stages.sales_count,
      // keitaro_sales_count / keitaro_revenue were per-stage correlated subqueries
      // in this SELECT (2 subplans PER stage row, filtered on a bare stage_id that
      // keitaro_stage_results has no leading index for). Replaced by ONE grouped
      // query keyed on campaign_id (indexed) in the Promise.all below, mapped in
      // like sendCountsByStage. Same values (COALESCE 0), no N+1.
      sales_payout_each: campaign_stages.sales_payout_each,
      notes: campaign_stages.notes,
      tracking_id: campaign_stages.tracking_id,
      split_index: campaign_stages.split_index,
      split_total: campaign_stages.split_total,
      behavioral_tier: campaign_stages.behavioral_tier,
      parent_stage_id: campaign_stages.parent_stage_id,
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
        cost_per_sms: provider_phones.cost_per_sms,
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

  // Per-stage audience_count. Two kinds of stage:
  //   • Every non-lane stage → counted in ONE batched pass (active frozen-pool
  //     or draft projection), replacing the former one-query-per-stage N+1. The
  //     batched functions are numerically identical to the per-stage ones
  //     (proven by scripts/tmp-verify-batch.ts before ship).
  //   • Behavioral lanes (behavioral_tier set) → their LIVE preview is a
  //     seconds-long tier scan PER LANE. That work is deferred OFF this request:
  //     lanes return audience_count = null here, and the client fills them in
  //     from GET .../stages/lane-counts (one batched query) after first paint.
  //     Keeping it inline made a 3-lane campaign's list take 30–60s.
  const plainStages = rows.filter((r) => r.behavioral_tier == null);

  const plainBatchItems = plainStages.map((r) => ({
    stageId: r.id,
    include_no_status: r.include_no_status,
    include_clickers: r.include_clickers,
    exclude_clickers: r.exclude_clickers,
    split_index: r.split_index,
    split_total: r.split_total,
  }));

  const plainCounts = isDraft
    ? await computeStageAudienceCountsBatchForDraft(draftAudienceInput, plainBatchItems)
    : await computeStageAudienceCountsBatch(cid, orgId, plainBatchItems);

  // Reassemble in the original row order. Lane rows are null (deferred → filled
  // client-side); non-lane rows get their batched count.
  const audienceCounts = rows.map((r) =>
    r.behavioral_tier != null ? null : plainCounts.get(r.id) ?? 0,
  );

  // Inbound STOPs attributed to this campaign (migration 0075). Per-stage counts
  // come from the persistent campaign_stages.inbound_opt_out_count counter (in
  // the select above), maintained by the opt-out poller's 72h-window attribution
  // — the SAME source the Reports page reads, so the two never disagree. Here we
  // additionally fetch the campaign-level DISTINCT-contact total: summing the
  // per-stage counters would over-count anyone hit by multiple stages of this
  // campaign (window semantics credit every stage that sent to them).
  // These two are independent of each other — run in one round-trip, not two.
  // (1) Inbound STOPs attributed to this campaign (migration 0075). Per-stage
  // counts come from the persistent campaign_stages.inbound_opt_out_count counter
  // (in the select above), maintained by the opt-out poller's 72h-window
  // attribution — the SAME source the Reports page reads, so the two never
  // disagree. Here we additionally fetch the campaign-level DISTINCT-contact total:
  // summing the per-stage counters would over-count anyone hit by multiple stages.
  // (2) WS4 §0 materialization signal: stage_sends counts by status, one grouped
  // query (indexed on stage_id) — no N+1. Drives the Orange↔Blue operational-status
  // split on the client via deriveStageOperationalStatus.
  const [inboundStopContactsRow, sendCountRows, keitaroRows] = (await Promise.all([
    db.execute(drizzleSql`
      SELECT count(DISTINCT oo.contact_id)::int AS n
      FROM opt_out_attributions oa
      JOIN opt_outs oo ON oo.id = oa.opt_out_id
      WHERE oa.org_id = ${orgId} AND oa.campaign_id = ${cid}
    `),
    db.execute(drizzleSql`
      SELECT
        stage_id,
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status = 'sending')::int AS sending,
        count(*) FILTER (WHERE status = 'sent')::int AS sent,
        count(*) FILTER (WHERE status IN ('failed', 'rejected'))::int AS failed,
        count(*) FILTER (WHERE status = 'skipped_duplicate')::int AS skipped_duplicate
      FROM stage_sends
      WHERE org_id = ${orgId} AND campaign_id = ${cid}
      GROUP BY stage_id
    `),
    // Keitaro sales/revenue per stage — one grouped query keyed on campaign_id
    // (served by keitaro_stage_results_campaign_date_idx) instead of the former
    // 2×N per-stage correlated subqueries. Numerically identical (missing stage
    // → COALESCE 0 in the mapping below).
    db.execute(drizzleSql`
      SELECT stage_id,
             sum(sales)::int AS sales,
             sum(revenue)::numeric(12,4)::text AS revenue
      FROM ${keitaro_stage_results}
      WHERE org_id = ${orgId} AND campaign_id = ${cid}
      GROUP BY stage_id
    `),
  ])) as unknown as [
    { n: number }[],
    {
      stage_id: number;
      total: number;
      pending: number;
      sending: number;
      sent: number;
      failed: number;
      skipped_duplicate: number;
    }[],
    { stage_id: number; sales: number; revenue: string }[],
  ];
  const inboundStopContacts = Number(inboundStopContactsRow[0]?.n ?? 0);
  const keitaroByStage = new Map(
    keitaroRows.map((r) => [
      Number(r.stage_id),
      { sales: Number(r.sales ?? 0), revenue: r.revenue ?? "0.0000" },
    ]),
  );
  const sendCountsByStage = new Map(
    sendCountRows.map((r) => [
      Number(r.stage_id),
      {
        total: Number(r.total),
        pending: Number(r.pending),
        sending: Number(r.sending),
        sent: Number(r.sent),
        failed: Number(r.failed),
        skippedDuplicate: Number(r.skipped_duplicate),
      },
    ]),
  );

  let data = rows.map((r, i) => ({
    ...r,
    link_mode: linkMode,
    creative: r.creative?.id ? r.creative : null,
    provider: r.provider?.id ? r.provider : null,
    provider_phone: r.provider_phone?.id ? r.provider_phone : null,
    brand: r.brand?.id ? r.brand : null,
    offer: r.offer?.id ? r.offer : null,
    audience_count: audienceCounts[i],
    inbound_stop_count: r.inbound_opt_out_count,
    keitaro_sales_count: keitaroByStage.get(r.id)?.sales ?? 0,
    keitaro_revenue: keitaroByStage.get(r.id)?.revenue ?? "0.0000",
    send_counts: sendCountsByStage.get(r.id) ?? {
      total: 0,
      pending: 0,
      sending: 0,
      sent: 0,
      failed: 0,
      skippedDuplicate: 0,
    },
  }));

  // audience_count is derived in JS post-query; sort it here when the
  // client asks for it. SQL-side ordering is handled above for the
  // built-in columns. Lane rows carry a null count (deferred to the
  // lane-counts endpoint) — treat those as 0 for ordering purposes.
  if (listParams.sortBy === "audience_count") {
    const dir = sortDirRaw === "desc" ? -1 : 1;
    data = [...data].sort(
      (a, b) => dir * ((a.audience_count ?? 0) - (b.audience_count ?? 0)),
    );
  }

  return NextResponse.json({
    data,
    totalCount: data.length,
    inbound_stop_contacts: inboundStopContacts,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

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

  // A new stage can't be scheduled in the past (would immediately miss its
  // window). Server-side source of truth; the form mirrors this client-side.
  if (input.scheduled_at && isScheduledAtInPast(input.scheduled_at)) {
    return apiError(
      400,
      "Scheduled time can't be in the past",
      API_ERROR_CODES.VALIDATION,
      { field: "scheduled_at" },
    );
  }

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

  // Reject a malformed guidekn destination on a hand-edited (non-auto) full_url
  // BEFORE it can be stored. Shape-only (the stage tracking id isn't generated
  // until the transaction below); the send path re-validates and rebuilds if
  // sub_id3 ever drifts from the stage's tracking_id. Auto mode stores the bare
  // sales-page URL and is exempt.
  if (!fullUrlAuto) {
    const destErr = validateDestination(nullIfEmpty(input.full_url) ?? "", null);
    if (destErr) {
      return apiError(400, destErr, API_ERROR_CODES.VALIDATION, {
        field: "full_url",
      });
    }
  }

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

    let finalRow = row;
    if (Object.keys(setOnUpdate).length > 0) {
      const [withUpdates] = await tx
        .update(campaign_stages)
        .set(setOnUpdate)
        .where(eq(campaign_stages.id, row.id))
        .returning();
      finalRow = withUpdates;
    }

    await logCampaignEvent(tx, {
      orgId,
      campaignId: cid,
      stageId: finalRow.id,
      actorUserId: user.id,
      eventType: "stage_created",
      summary: `Stage ${finalRow.stage_number} created`,
      metadata: { stage_number: finalRow.stage_number },
    });

    return finalRow;
  });

  return NextResponse.json(created, { status: 201 });
}
