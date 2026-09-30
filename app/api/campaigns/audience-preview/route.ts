import { and, eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { contact_groups, segments } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { newCampaignUsesLifecycleRules } from "@/lib/engagement/lifecycle-gate";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { previewAudience } from "@/lib/audience-snapshot";
import { can } from "@/lib/permissions";
import { audiencePreviewSchema } from "@/lib/validators/campaigns";

// ⚠️ THIS ROUTE HAD NO maxDuration, on a query that takes SECONDS.
//
// Measured on production for one real recipe — Hot/Warm x three contact groups
// x one offer with the cooldown/limit rules on — the preview runs 6.5-18s and
// was seen at 47s. It had been running on the platform default the whole time,
// so a slow recipe returned a 504 and the form showed "Could not preview
// audience - fix any issues above", which reads as a VALIDATION problem the
// operator could correct. There was nothing to correct.
//
// 60s matches the other heavy read routes (reports/lifecycle,
// reports/group-lifecycle). It is a floor under the failure, NOT a fix for the
// latency: a preview that fires as the operator edits the form has no business
// taking eight seconds, and that is tracked separately.
export const maxDuration = 60;

// Live count of contacts that would be in the audience pool given a set
// of segments, contact groups, and a filter snapshot. Writes nothing.
// The campaign creation dialog calls this whenever filters change so the
// operator sees the impact before clicking "Launch".
//
// Returns { count, total_matching, applied_cap }: count is the effective
// post-cap audience, total_matching is the full pool before the cap is
// applied. When no cap is set or the cap exceeds the pool, the two
// match.
export async function POST(req: NextRequest) {
  const auth = await requireApiMembership({
    route: "campaigns/audience-preview",
    method: "POST",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "campaigns.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = audiencePreviewSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }
  const segmentIds = Array.from(new Set(parsed.data.audience_segment_ids));
  const excludeSegmentIds = Array.from(
    new Set(parsed.data.audience_exclude_segment_ids),
  );
  const groupIds = Array.from(new Set(parsed.data.audience_contact_group_ids));

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
  if (groupIds.length > 0) {
    const found = await db
      .select({ id: contact_groups.id })
      .from(contact_groups)
      .where(
        and(
          eq(contact_groups.org_id, orgId),
          inArray(contact_groups.id, groupIds),
        ),
      );
    if (found.length !== groupIds.length) {
      return apiError(
        400,
        "One or more audience_contact_group_ids don't belong to your organization",
        API_ERROR_CODES.VALIDATION,
        { field: "audience_contact_group_ids" },
      );
    }
  }

  // ⚠️ There is no campaign row yet, so `lifecycle_rules` cannot be read from
  // one — and reading nothing is what made this preview ignore the chips
  // entirely. It asks the SAME question the create route will answer when it
  // writes the row, through the same function, so the preview and the campaign
  // it previews cannot disagree.
  const lifecycleRules = await newCampaignUsesLifecycleRules(db, orgId);

  // ⚠️ A TIMED-OUT PREVIEW IS A 400 WITH A SENTENCE THE OPERATOR CAN ACT ON,
  // not a 500 and not Vercel's timeout page. previewAudience caps itself with
  // SET LOCAL statement_timeout; Postgres raises 57014 and the transaction
  // rolls back, which is a normal outcome for an over-broad selection, not a
  // fault. Left unmapped it read as "Could not preview audience -- fix any
  // issues above", which points at the form when the answer is to narrow it.
  let result: Awaited<ReturnType<typeof previewAudience>>;
  try {
    result = await previewAudience({
      orgId,
      lifecycleRules,
      segmentIds,
      excludeSegmentIds,
      contactGroupIds: groupIds,
      filters: parsed.data.audience_filters ?? {},
      cap: parsed.data.audience_cap ?? null,
      // Default true to mirror the campaign column default — a preview with
      // the flag omitted matches a campaign created without specifying it.
      excludeInUse: parsed.data.exclude_in_use_contacts ?? true,
      // Content-dedup LAYER 3 (preview only). offer_id is scoped by org_id in
      // the query, so no separate ownership check is needed — a foreign id
      // simply matches no exposures (and we avoid the extra round-trip).
      excludePriorOffer: parsed.data.exclude_prior_offer_contacts ?? false,
      // A campaign being created gets the new semantics, so the preview must
      // use them too — otherwise the numbers on screen describe a rule the
      // campaign will not actually run.
      offerRulesEnabled: lifecycleRules,
      offerCooldownDays: parsed.data.offer_cooldown_days ?? 7,
      offerLimitTimes: parsed.data.offer_limit_times ?? 5,
      offerId: parsed.data.offer_id ?? null,
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "57014") {
      return apiError(
        400,
        "Audience preview timed out — narrow the selection (fewer contact groups, or add a status filter) and try again.",
        API_ERROR_CODES.VALIDATION,
        { reason: "preview_timeout" },
      );
    }
    throw e;
  }
  return NextResponse.json(result);
}
