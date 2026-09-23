import { NextResponse, type NextRequest } from "next/server";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { REST_DAYS_DEFAULT, REST_DAYS_MAX } from "@/lib/audience/pool-math";
import { readAudiencePools } from "@/lib/audience/pools";
import { can } from "@/lib/permissions";

// "How many contacts could still be sent offer X?" — per active contact group:
// never received × rested, the re-touch pool, clickers who did not buy.
//
// Counts only: group NAMES and integers. The rollup never holds a contact id or
// a phone number (lib/audience/pools.ts), so there is nothing to strip here.
// Serves an HOURLY rollup and says so: computed_at + stale_seconds on every
// response, 503 rather than zeros before the first run.
//
// The counts are PLANNING figures — "roughly how many can I still mail for
// offer X" while sizing a send — and an hour of staleness does not change that
// decision. Nothing on the send, preflight, kickoff or compliance path reads
// them: send-time opt-out suppression re-reads `opt_outs` live at the moment of
// claim (lib/sends/drain.ts, the SEND-TIME OPT-OUT INVARIANT). Verified as the
// blocking condition of the 2026-09-23 cadence cut; if that ever stops being
// true, this cadence is wrong, not just stale.
export const dynamic = "force-dynamic";

// offers.id is an int4: anything larger would reach Postgres as a 22003.
const MAX_INT4 = 2_147_483_647;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership({ route: "audience/pools", method: "GET" });
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "contacts.stats")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const sp = req.nextUrl.searchParams;
  const offerRaw = sp.get("offer_id");
  const offerId = offerRaw != null && /^\d+$/.test(offerRaw) ? Number(offerRaw) : Number.NaN;
  if (!Number.isInteger(offerId) || offerId <= 0 || offerId > MAX_INT4) {
    return apiError(
      400,
      "offer_id is required and must be a positive whole number",
      API_ERROR_CODES.VALIDATION,
      { field: "offer_id" },
    );
  }
  const restRaw = sp.get("rest_days");
  const restDays =
    restRaw == null ? REST_DAYS_DEFAULT : /^\d+$/.test(restRaw) ? Number(restRaw) : Number.NaN;
  if (!Number.isInteger(restDays) || restDays < 0 || restDays > REST_DAYS_MAX) {
    return apiError(
      400,
      `rest_days must be a whole number from 0 to ${REST_DAYS_MAX}`,
      API_ERROR_CODES.VALIDATION,
      { field: "rest_days" },
    );
  }

  const result = await readAudiencePools(auth.orgId, offerId, restDays);
  switch (result.status) {
    case "ok":
      return NextResponse.json(result.pools);
    case "offer_not_found":
      return apiError(404, "Offer not found", API_ERROR_CODES.NOT_FOUND, { entity: "offer" });
    case "rollup_not_ready":
      return apiError(
        503,
        "Audience pools have not been computed yet. The refresh runs hourly.",
        API_ERROR_CODES.INTERNAL,
        { reason: "rollup_not_ready" },
      );
    case "offer_not_in_rollup_yet":
      return apiError(
        503,
        "This offer first sent after the last refresh. It appears within the hour.",
        API_ERROR_CODES.INTERNAL,
        { reason: "offer_not_in_rollup_yet" },
      );
  }
}
