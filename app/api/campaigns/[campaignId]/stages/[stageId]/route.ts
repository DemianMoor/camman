import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  campaign_stages,
  campaigns,
  creatives,
  provider_phones,
  sms_providers,
} from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { buildStageFullUrl } from "@/lib/stage-url";
import { loadStageUrlContext } from "@/lib/stage-url-context";
import {
  nullIfEmpty,
  stageUpdateSchema,
} from "@/lib/validators/campaign-stages";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const NULLABLE_OPTIONAL_STRING = new Set([
  "label",
  "sales_page_label",
  "short_url",
  "full_url",
  "notes",
]);

// stage_number is immutable once assigned; campaign_id is path-bound; the
// counters and audit columns are managed by the import/state flow.
const NON_UPDATABLE = new Set([
  "stage_number",
  "campaign_id",
  "sent_at",
  "previous_status",
  "status",
  "status_changed_at",
  "sms_count",
  "total_cost",
  "delivered_count",
  "opt_out_count",
  "click_count",
  "scrubbed_count",
  "bounced_count",
  "archived_at",
  "created_at",
  // tracking_id is system-generated and immutable; rejected upstream by
  // the validator with a TRACKING_ID_IMMUTABLE code, but listed here as
  // a backstop in case the validator changes. Mutating creative_id does
  // NOT regenerate tracking_id — the historical reference stays.
  "tracking_id",
  // Split partition fields are owned by the /split endpoint; PATCH
  // silently drops them rather than mutating in place.
  "split_index",
  "split_total",
  // Transient request-only flag (see validator); never a column.
  "full_url_auto",
]);

export async function GET(
  _req: NextRequest,
  {
    params,
  }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "stages.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId, stageId } = await params;
  const cid = parseId(campaignId);
  const sid = parseId(stageId);
  if (cid === null || sid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

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
      scrubbed_count: campaign_stages.scrubbed_count,
      bounced_count: campaign_stages.bounced_count,
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
    .where(
      and(
        eq(campaign_stages.id, sid),
        eq(campaign_stages.campaign_id, cid),
        eq(campaign_stages.org_id, orgId),
      ),
    )
    .limit(1);

  if (!rows[0]) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "stage",
    });
  }
  const r = rows[0];
  return NextResponse.json({
    ...r,
    creative: r.creative?.id ? r.creative : null,
    provider: r.provider?.id ? r.provider : null,
    provider_phone: r.provider_phone?.id ? r.provider_phone : null,
  });
}

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "stages.update")) {
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
  const parsed = stageUpdateSchema.safeParse(json);
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

  // FK ownership checks for any of the optional refs being changed.
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

  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (NON_UPDATABLE.has(k)) continue;
    if (k === "scheduled_at") {
      updates[k] = typeof v === "string" ? new Date(v) : null;
      continue;
    }
    if (k === "utm_tag_ids") {
      updates[k] = (v as number[] | null) ?? [];
      continue;
    }
    updates[k] = NULLABLE_OPTIONAL_STRING.has(k) ? nullIfEmpty(v as string) : v;
  }

  // Full URL handling: verify UTM tag ownership when the selection changes,
  // and — when full_url_auto — authoritatively rebuild full_url from the
  // effective sales page + offer postfix + the stage's (immutable) tracking
  // ID + selected UTM tags, overriding any full_url text in the payload.
  const fullUrlAuto = input.full_url_auto === true;
  if (fullUrlAuto || input.utm_tag_ids !== undefined) {
    const existing = await db
      .select({
        tracking_id: campaign_stages.tracking_id,
        sales_page_label: campaign_stages.sales_page_label,
        utm_tag_ids: campaign_stages.utm_tag_ids,
        offer_id: campaigns.offer_id,
      })
      .from(campaign_stages)
      .leftJoin(campaigns, eq(campaigns.id, campaign_stages.campaign_id))
      .where(
        and(
          eq(campaign_stages.id, sid),
          eq(campaign_stages.campaign_id, cid),
          eq(campaign_stages.org_id, orgId),
        ),
      )
      .limit(1);
    if (!existing[0]) {
      return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, {
        entity: "stage",
      });
    }
    const effLabel =
      input.sales_page_label !== undefined
        ? nullIfEmpty(input.sales_page_label)
        : existing[0].sales_page_label;
    const effUtmIds =
      input.utm_tag_ids !== undefined
        ? (input.utm_tag_ids ?? [])
        : (existing[0].utm_tag_ids ?? []);
    const ctxResult = await loadStageUrlContext({
      orgId,
      offerId: existing[0].offer_id,
      salesPageLabel: effLabel,
      utmTagIds: effUtmIds,
    });
    if (!ctxResult.ok) {
      return apiError(
        400,
        "A selected UTM tag doesn't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "utm_tag_ids" },
      );
    }
    if (fullUrlAuto) {
      // Auto full_url is the BARE sales-page URL; tracking/UTM params are
      // attached manually and stored verbatim once the URL is hand-edited.
      updates.full_url =
        buildStageFullUrl({ salesPageUrl: ctxResult.ctx.salesPageUrl }) || null;
    }
  }

  if (Object.keys(updates).length === 0) {
    return apiError(
      400,
      "No editable fields provided",
      API_ERROR_CODES.VALIDATION,
    );
  }

  const [updated] = await db
    .update(campaign_stages)
    .set(updates)
    .where(
      and(
        eq(campaign_stages.id, sid),
        eq(campaign_stages.campaign_id, cid),
        eq(campaign_stages.org_id, orgId),
      ),
    )
    .returning();
  if (!updated) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "stage",
    });
  }
  return NextResponse.json(updated);
}
