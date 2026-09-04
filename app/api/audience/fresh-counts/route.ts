import { NextResponse } from "next/server";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { readFreshCounts } from "@/lib/audience/fresh-counts";

// "How many fresh leads do I have to assign?" (ClickUp 869evpmbz).
//
// Counts only. The payload contains group NAMES and integers — no ids, no phone
// numbers, no contact fields, nothing derived from an individual. That is not
// enforced by stripping fields here; it is enforced by the ROLLUP never holding
// anything else (see lib/audience/fresh-counts.ts and migration 0176). A
// redaction step someone can forget is weaker than a payload that never held
// the secret.
//
// ⚠️ SERVES A ROLLUP, AND SAYS SO. `computed_at` and `stale_seconds` are in
// every response precisely because the honest failure mode of this endpoint is
// a confidently stale number — which is exactly what made segment_stats
// unusable for this question in the first place. The caller can decide whether
// the age is acceptable; it can never be misled about it.
//
// Gated on `contacts.stats`, the same permission contacts/base-stats uses: the
// aggregate-only permission a role may hold while never being allowed to see a
// contact row.
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireApiMembership({
    route: "audience/fresh-counts",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "contacts.stats")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { counts, computedAt } = await readFreshCounts(orgId);

  if (!counts || !computedAt) {
    // 503, not 200-with-nulls: "the rollup has never run" is a service state,
    // not an answer of zero. An agent must not read an empty result as "you
    // have no fresh leads".
    return apiError(
      503,
      "Fresh counts have not been computed yet. The refresh runs every 30 minutes.",
      API_ERROR_CODES.INTERNAL,
      { reason: "rollup_not_ready" },
    );
  }

  return NextResponse.json({
    ...counts,
    computed_at: computedAt,
    stale_seconds: Math.max(
      0,
      Math.round((Date.now() - new Date(computedAt).getTime()) / 1000),
    ),
    // Spelled out in the payload so a caller that never reads the docs still
    // cannot mistake this for "not messaged". See the definition note in
    // lib/audience/fresh-counts.ts.
    definition:
      "not_used = not snapshotted into any campaign that ran (active/paused/completed) in the window; excludes archived contacts and opt-outs",
  });
}
