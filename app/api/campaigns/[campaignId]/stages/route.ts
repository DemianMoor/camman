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
import { can } from "@/lib/permissions";
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
      notes: campaign_stages.notes,
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
      offer: { id: offers.id, name: offers.name, color: offers.color },
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

  const data = rows.map((r) => ({
    ...r,
    creative: r.creative?.id ? r.creative : null,
    provider: r.provider?.id ? r.provider : null,
    provider_phone: r.provider_phone?.id ? r.provider_phone : null,
    brand: r.brand?.id ? r.brand : null,
    offer: r.offer?.id ? r.offer : null,
  }));

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
    .select({ id: campaigns.id, status: campaigns.status })
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
    stop_text: input.stop_text,
    include_clickers: input.include_clickers,
    exclude_clickers: input.exclude_clickers,
    include_no_status: input.include_no_status,
    scheduled_at: input.scheduled_at ? new Date(input.scheduled_at) : null,
    notes: nullIfEmpty(input.notes),
    status: "draft",
  };

  const [created] = await db
    .insert(campaign_stages)
    .values(values as typeof campaign_stages.$inferInsert)
    .returning();
  return NextResponse.json(created, { status: 201 });
}
