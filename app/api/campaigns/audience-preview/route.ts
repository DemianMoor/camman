import { and, eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { contact_groups, segments } from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { newCampaignUsesLifecycleRules } from "@/lib/engagement/lifecycle-gate";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { previewTimeoutResponse } from "@/lib/api/preview-timeout";
import { referencePreviewAudience } from "@/lib/audience-preview-reference";
import {
  PreviewBusyError,
  previewAudience,
  previewAudienceAudiencePart,
  previewAudienceBase,
} from "@/lib/audience-snapshot";
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
//
// ⚠️ HOTFIX 2026-10-01, TEMPORARY: 120 s, back down after Task 2 T5. The
// preview's statement ceiling is now 110 s (PREVIEW_STATEMENT_TIMEOUT) because
// real segment recipes take 40-100 s; the function must outlive the query or
// Vercel kills it first and the operator gets a 504 instead of the 400.
export const maxDuration = 120;

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
  // KILL SWITCH (Task 2, [change 4]). AUDIENCE_PREVIEW_IMPL=reference routes
  // the preview to the frozen pre-Task-2 implementation, so a production
  // problem with the rebuilt preview is one Vercel env change and a redeploy
  // away, with no revert. Read per request. Any other value, or none, serves
  // the live one. The response names which implementation served it
  // (x-audience-preview-impl), so the switch can be confirmed rather than
  // assumed. Removed together with lib/audience-preview-reference/.
  const impl =
    process.env.AUDIENCE_PREVIEW_IMPL === "reference" ? "reference" : "live";
  // Hotfix 2026-10-01 (until T6): one running preview per user AND part, so a
  // superseded or retried preview cannot stack another long query, while the
  // two halves of one preview (T5) still run side by side. The frozen
  // reference (kill switch) runs without the lock.
  const part = parsed.data.part;
  const singleFlightKey = `${orgId}:${auth.user?.id ?? "token"}:${part ?? "full"}`;
  const input: Parameters<typeof previewAudience>[0] = {
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
  };

  // Task 2 T5. Without `part` the answer is the whole preview in TODAY'S shape —
  // operator API tokens call this route and must not see a change. With a
  // part, the answer is { part, data }. Under the kill switch every request
  // is served whole by the frozen reference and says so (part: "full"), and
  // the form shows it as is instead of merging.
  let body: unknown;
  try {
    if (impl === "reference") {
      const full = await referencePreviewAudience(input);
      body = part ? { part: "full", data: full } : full;
    } else if (part === "base") {
      body = {
        part: "base",
        data: await previewAudienceBase(input, undefined, { singleFlightKey }),
      };
    } else if (part === "audience") {
      body = {
        part: "audience",
        data: await previewAudienceAudiencePart(input, undefined, {
          singleFlightKey,
        }),
      };
    } else {
      body = await previewAudience(input, undefined, { singleFlightKey });
    }
  } catch (e) {
    // Via the cause chain: the 57014 is on err.cause, not err (869faaa3v).
    const timeout = previewTimeoutResponse(e);
    if (timeout) return timeout;
    if (e instanceof PreviewBusyError) {
      // The form waits for the running one and retries; not an error to fix.
      return apiError(
        409,
        "Your previous audience preview is still running — retrying shortly.",
        API_ERROR_CODES.CONFLICT,
        { reason: "preview_busy" },
      );
    }
    throw e;
  }
  return NextResponse.json(body, {
    headers: { "x-audience-preview-impl": impl },
  });
}
