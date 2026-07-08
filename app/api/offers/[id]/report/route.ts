import { type NextRequest, NextResponse } from "next/server";

import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import { db } from "@/db/client";
import { and, eq } from "drizzle-orm";
import { offers } from "@/db/schema";
import {
  getOfferGroupReport,
  type RawMetrics,
} from "@/lib/reporting/offer-group-report";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "offers.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { id } = await params;
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

  // offerTotals = sum of the visible group rows (foots the table; multi-group
  // campaigns counted fully in each group — same footnote as the rows).
  const offerTotals: RawMetrics = report.rows.reduce(
    (t, r) => ({
      sends: t.sends + r.sends,
      revenue: t.revenue + r.revenue,
      sales: t.sales + r.sales,
      clicks: t.clicks + r.clicks,
      cost: t.cost + r.cost,
      optouts: t.optouts + r.optouts,
    }),
    { sends: 0, revenue: 0, sales: 0, clicks: 0, cost: 0, optouts: 0 },
  );

  const breakEvenPer1k =
    offerTotals.sends > 0 ? (offerTotals.cost / offerTotals.sends) * 1000 : null;

  return NextResponse.json({
    offerName: offer.name,
    rows: report.rows,
    offerTotals,
    orgBenchmark: report.orgBenchmark,
    breakEvenPer1k,
    refreshedAt: report.refreshedAt,
  });
}
