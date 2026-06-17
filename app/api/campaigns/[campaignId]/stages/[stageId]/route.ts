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
import { logCampaignEvent } from "@/lib/campaign-events";
import { can } from "@/lib/permissions";
import { decideScheduleEdit } from "@/lib/sends/schedule-edit";
import { buildStageFullUrl } from "@/lib/stage-url";
import { loadStageUrlContext } from "@/lib/stage-url-context";
import {
  generateCampaignTrackingId,
  generateStageTrackingId,
} from "@/lib/tracking-id";
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
  // Behavioral-lane identity is owned by the /behavioral-split endpoint and is
  // immutable. The validator (stageUpdateSchema) doesn't include these, so Zod
  // already strips them; listed here as an explicit backstop. The DB CHECK
  // would reject an incoherent change anyway.
  "behavioral_tier",
  "parent_stage_id",
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
  const { orgId, role, user } = auth;

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

  // Load the current stage + parent campaign context once. Needed both for
  // the Full URL rebuild (sales page / UTM / offer) and for backfilling the
  // stage's tracking_id when a creative is added to a stage that didn't have
  // one at create time (e.g. split siblings cloned from a creative-less
  // source). Read unconditionally so the tracking backfill runs on any PATCH.
  const existing = await db
    .select({
      tracking_id: campaign_stages.tracking_id,
      creative_id: campaign_stages.creative_id,
      stage_number: campaign_stages.stage_number,
      sales_page_label: campaign_stages.sales_page_label,
      utm_tag_ids: campaign_stages.utm_tag_ids,
      current_scheduled_at: campaign_stages.scheduled_at,
      sent_at: campaign_stages.sent_at,
      schedule_missed_at: campaign_stages.schedule_missed_at,
      campaign_tracking_id: campaigns.tracking_id,
      campaign_brand_id: campaigns.brand_id,
      campaign_offer_id: campaigns.offer_id,
      campaign_created_at: campaigns.created_at,
      campaign_link_mode: campaigns.link_mode,
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
  const current = existing[0];

  // Scheduled-send edit lock (server-side enforcement; UI hiding is not enough).
  // Once a tracked (API) stage has fired (sent_at set), its scheduled time is
  // frozen. A MISSED scheduled attempt leaves sent_at NULL, so it stays
  // reschedulable — see lib/sends/schedule-edit.ts. The form always echoes
  // scheduled_at, so the decision compares values, not mere presence.
  const scheduleEdit = decideScheduleEdit(
    {
      linkMode: current.campaign_link_mode,
      sentAt: current.sent_at,
      scheduleMissedAt: current.schedule_missed_at,
      currentScheduledAt: current.current_scheduled_at,
    },
    input.scheduled_at,
  );

  if (scheduleEdit.locked) {
    return apiError(
      409,
      "The scheduled time is locked — this stage has already been sent",
      API_ERROR_CODES.CONFLICT,
      { reason: "scheduled_locked_after_send" },
    );
  }

  // Rescheduling a missed scheduled send clears the marker and re-arms it for
  // the send-scheduled cron.
  if (scheduleEdit.clearMissed) {
    updates.schedule_missed_at = null;
  }

  // Full URL handling: verify UTM tag ownership when the selection changes,
  // and — when full_url_auto — authoritatively rebuild full_url from the
  // effective sales page + offer postfix + selected UTM tags, overriding any
  // full_url text in the payload.
  const fullUrlAuto = input.full_url_auto === true;
  if (fullUrlAuto || input.utm_tag_ids !== undefined) {
    const effLabel =
      input.sales_page_label !== undefined
        ? nullIfEmpty(input.sales_page_label)
        : current.sales_page_label;
    const effUtmIds =
      input.utm_tag_ids !== undefined
        ? (input.utm_tag_ids ?? [])
        : (current.utm_tag_ids ?? []);
    const ctxResult = await loadStageUrlContext({
      orgId,
      offerId: current.campaign_offer_id,
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

  // Stage tracking_id backfill. The ID is write-once and immutable, so we
  // only ever set it when it's currently NULL. It needs the stage to have a
  // creative AND the parent campaign to have (or be able to generate, from
  // brand+offer) a tracking_id. This mirrors the stage POST path — it's what
  // makes "pick a creative and save" actually produce an ID for a stage that
  // was created without one (e.g. split siblings, or a draft stage whose
  // creative is chosen later). The actual generation happens in the
  // transaction below so type narrowing stays sound.
  const effectiveCreativeId =
    input.creative_id !== undefined ? input.creative_id : current.creative_id;
  const canGenerateCampaignTracking =
    current.campaign_tracking_id != null ||
    (current.campaign_brand_id != null && current.campaign_offer_id != null);
  const willGenerateStageTracking =
    current.tracking_id == null &&
    effectiveCreativeId != null &&
    canGenerateCampaignTracking;

  if (Object.keys(updates).length === 0 && !willGenerateStageTracking) {
    return apiError(
      400,
      "No editable fields provided",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // One transaction so a campaign-tracking-id backfill and the stage update
  // can't half-apply.
  const updated = await db.transaction(async (tx) => {
    if (current.tracking_id == null && effectiveCreativeId != null) {
      let campaignTrackingId = current.campaign_tracking_id;
      if (
        campaignTrackingId == null &&
        current.campaign_brand_id != null &&
        current.campaign_offer_id != null &&
        current.campaign_created_at != null
      ) {
        // Pre-tracking-id campaigns / drafts upgraded out-of-band: generate
        // the campaign's tracking_id now so the stage can reference it.
        campaignTrackingId = await generateCampaignTrackingId(tx, {
          orgId,
          brandId: current.campaign_brand_id,
          offerId: current.campaign_offer_id,
          createdAt: current.campaign_created_at,
        });
        await tx
          .update(campaigns)
          .set({ tracking_id: campaignTrackingId })
          .where(eq(campaigns.id, cid));
      }
      if (campaignTrackingId != null) {
        // tracking_id is server-generated, not taken from the payload (the
        // validator rejects a client-supplied one), so set it directly.
        updates.tracking_id = generateStageTrackingId({
          campaignTrackingId,
          stageNumber: current.stage_number,
          creativeId: effectiveCreativeId,
        });
      }
    }

    const [row] = await tx
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
    return row;
  });

  if (!updated) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "stage",
    });
  }

  // Audit a scheduled-time change (set / moved / cleared) — the most send-
  // relevant stage edit. Compare values so a form that always echoes
  // scheduled_at doesn't log a no-op event on every save.
  if (input.scheduled_at !== undefined) {
    const nextMs = input.scheduled_at
      ? new Date(input.scheduled_at).getTime()
      : null;
    const prevMs = current.current_scheduled_at
      ? new Date(current.current_scheduled_at).getTime()
      : null;
    if (nextMs !== prevMs) {
      await logCampaignEvent(db, {
        orgId,
        campaignId: cid,
        stageId: sid,
        actorUserId: user.id,
        eventType: "stage_scheduled",
        summary: input.scheduled_at
          ? `Stage ${current.stage_number} scheduled for ${input.scheduled_at}`
          : `Stage ${current.stage_number} schedule cleared`,
        metadata: {
          stage_number: current.stage_number,
          scheduled_at: input.scheduled_at ?? null,
          previous_scheduled_at: current.current_scheduled_at,
        },
      });
    }
  }

  return NextResponse.json(updated);
}
