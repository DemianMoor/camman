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

  const result = await previewAudience({
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
  return NextResponse.json(result);
}
