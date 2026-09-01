import { type NextRequest, NextResponse } from "next/server";

import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import { db } from "@/db/client";
import { and, eq } from "drizzle-orm";
import { offers } from "@/db/schema";
import { getOfferGroupReport } from "@/lib/reporting/offer-group-report";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  const auth = await requireApiMembership({
    route: "offers/[offerId]/report",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "offers.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { offerId: id } = await params;
  const offerId = Number(id);
  if (!Number.isInteger(offerId) || offerId <= 0) {
    return apiError(400, "Invalid offer id", API_ERROR_CODES.VALIDATION, { field: "id" });
  }

  const [offer] = await db
    .select({ name: offers.name })
    .from(offers)
    .where(and(eq(offers.id, offerId), eq(offers.org_id, orgId)))
    .limit(1);
  if (!offer) {
    return apiError(404, "Offer not found", API_ERROR_CODES.NOT_FOUND, { entity: "offer" });
  }

  const report = await getOfferGroupReport(orgId, offerId);

  // The footer is read at OFFER grain, never summed from the group rows. Those
  // rows are per-recipient full counts and a contact in three of this offer's
  // groups appears in three of them -- summing them read 904,926 sends against
  // a true 88,536 on offer 96. The columns above this footer therefore do not
  // add up to it, which is stated in the UI rather than papered over.
  const { offerTotals } = report;

  const breakEvenPer1k =
    offerTotals.sends > 0 ? (offerTotals.cost / offerTotals.sends) * 1000 : null;

  return NextResponse.json({
    offerName: offer.name,
    rows: report.rows,
    offerTotals,
    orgBenchmark: report.orgBenchmark,
    benchmarkHasManual: report.benchmarkHasManual,
    breakEvenPer1k,
    // Sends that cannot reach any group row: recorded outside the app, from a
    // non-tracked/untargeted campaign, or to a recipient outside its targeted groups.
    unattributedSends: offerTotals.unattributed_sends,
    refreshedAt: report.refreshedAt,
  });
}
