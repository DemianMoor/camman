import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import { campaigns } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import {
  computeStageAudienceCount,
  computeStageAudienceCountForDraft,
  computeStageEligibilityPreview,
} from "@/lib/audience-snapshot";
import { can } from "@/lib/permissions";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const previewSchema = z
  .object({
    include_no_status: z.boolean().default(true),
    include_clickers: z.boolean().default(false),
    exclude_clickers: z.boolean().default(false),
    // Optional split partition. The form may send these when previewing
    // a split sibling stage; otherwise both are null and no partition is
    // applied.
    split_index: z.number().int().min(1).nullable().optional(),
    split_total: z.number().int().min(2).nullable().optional(),
    // The stage's selected creative, for the content-dedup eligibility preview.
    // Null/omitted ⇒ no creative dedup (Edge A): the eligibility breakdown still
    // returns (offer exclusion may apply), with saw_creative = 0.
    creative_id: z.number().int().positive().nullable().optional(),
  })
  .refine((d) => !(d.include_clickers && d.exclude_clickers), {
    path: ["include_clickers"],
    message: "include_clickers and exclude_clickers can't both be true",
  });

// Stage audience preview. The pool is frozen at campaign activation; this
// endpoint applies the stage-level filter toggles on top of that pool and
// always excludes contacts who are in opt_outs RIGHT NOW (not just at
// snapshot time). Returns the count plus a small breakdown for UI.
//
// TODO 7.2e: extend the "clickers" filter to also include contacts who
// have been recorded as clickers via CSV results imports against prior
// stages of THIS campaign. Currently uses snapshot booleans only.
export async function POST(
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

  // Confirm the campaign is in this org. Pull the full audience config
  // so we can route between frozen-pool mode (active+) and projected
  // mode (draft, pool empty).
  const campaignRow = await db
    .select({
      id: campaigns.id,
      status: campaigns.status,
      audience_snapshot_count: campaigns.audience_snapshot_count,
      audience_segment_ids: campaigns.audience_segment_ids,
      audience_contact_group_ids: campaigns.audience_contact_group_ids,
      audience_filters: campaigns.audience_filters,
      audience_cap: campaigns.audience_cap,
      exclude_in_use_contacts: campaigns.exclude_in_use_contacts,
      offer_id: campaigns.offer_id,
      exclude_prior_offer_contacts: campaigns.exclude_prior_offer_contacts,
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
  const parsed = previewSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Draft campaigns don't have a frozen pool yet — compute against the
  // campaign's planned audience instead so the operator can preview and
  // split stages before activation. After activation we always go
  // through the pool query (faster + reflects the random sample).
  const isDraft = campaignRow[0].status === "draft";
  const result = isDraft
    ? await computeStageAudienceCountForDraft(
        {
          id: cid,
          orgId,
          segmentIds: campaignRow[0].audience_segment_ids ?? [],
          contactGroupIds:
            campaignRow[0].audience_contact_group_ids ?? [],
          filters: campaignRow[0].audience_filters ?? {},
          cap: campaignRow[0].audience_cap ?? null,
          excludeInUse: campaignRow[0].exclude_in_use_contacts,
        },
        parsed.data,
      )
    : await computeStageAudienceCount(cid, orgId, parsed.data);

  // For "projected" mode the pool count we display is the cap (the
  // ceiling at activation). For "frozen" mode it's the actual snapshot.
  const pool_size = isDraft
    ? campaignRow[0].audience_cap ?? result.count
    : campaignRow[0].audience_snapshot_count;

  // Content-dedup eligibility breakdown (Phase 2 §5). Single timeout-guarded
  // query; the qualifying set resolves once and the indexed ledgers are cheap
  // joins on top. Reuses the same eligibility layers the send path EXCEPTs, so
  // `will_send` equals what materializes for the same inputs.
  const eligibility = await computeStageEligibilityPreview({
    orgId,
    campaignId: cid,
    mode: isDraft ? "draft" : "active",
    stageFilters: parsed.data,
    eligibility: {
      currentCreativeId: parsed.data.creative_id ?? null,
      currentOfferId: campaignRow[0].offer_id,
      excludePriorOffer: campaignRow[0].exclude_prior_offer_contacts,
    },
    draft: isDraft
      ? {
          segmentIds: campaignRow[0].audience_segment_ids ?? [],
          contactGroupIds: campaignRow[0].audience_contact_group_ids ?? [],
          filters: campaignRow[0].audience_filters ?? {},
          excludeInUse: campaignRow[0].exclude_in_use_contacts,
        }
      : undefined,
  });

  return NextResponse.json({
    count: result.count,
    breakdown: result.breakdown,
    pool_size,
    // `mode` lets the UI swap the "frozen" / "projected" labels without
    // duplicating the campaign-status check on the client.
    mode: isDraft ? "projected" : "frozen",
    // Content-dedup preview: { segment_total, saw_creative, got_offer,
    // will_send, truncated }. offer_excluded reflects the campaign toggle so the
    // UI knows whether to show the "already got offer" line.
    eligibility: {
      ...eligibility,
      offer_excluded: campaignRow[0].exclude_prior_offer_contacts,
    },
  });
}
