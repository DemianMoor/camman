import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { loadBrandLandingPairs } from "@/lib/api/brand-landing-pairs";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

// GET /api/brands/landing-pairs — the org's brand landing (host, path) pairs.
// The stage form validates a hand-edited Full URL against these so it refuses
// at Save what the link_destinations trigger (0212) would refuse at mint.
export async function GET() {
  const auth = await requireApiMembership({ route: "brands/landing-pairs", method: "GET" });
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "brands.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }
  return NextResponse.json({ data: await loadBrandLandingPairs(db, auth.orgId) });
}
