import { NextResponse, type NextRequest } from "next/server";

import { requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import { getLandingPageReport, offersWithSends } from "@/lib/reporting/landing-page-report";

// Read API for /reports/landing-pages — results per landing page for one offer,
// send-date basis (docs/04-features/landing-page-report.md). Without offer_id it
// returns the offer list for the picker. Gated on campaigns.view like every
// other report.
//
// No range cap: measured 2026-10-23, the largest offer's All Time read is
// well inside the limit (see the feature doc for 7d / 30d / All Time timings).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership({
    route: "reports/landing-pages",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "campaigns.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const offerRaw = sp.get("offer_id");
  if (offerRaw == null) {
    return NextResponse.json({ offers: await offersWithSends(auth.orgId) });
  }
  const offerId = Number(offerRaw);
  if (!Number.isInteger(offerId) || offerId <= 0) {
    return NextResponse.json({ error: "Invalid offer_id" }, { status: 400 });
  }

  // Both or neither: neither means All Time (offer created_at → today).
  const from = sp.get("from");
  const to = sp.get("to");
  if ((from == null) !== (to == null)) {
    return NextResponse.json({ error: "Pass both `from` and `to`, or neither for All Time" }, { status: 400 });
  }
  if (from != null && to != null) {
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      return NextResponse.json({ error: "Dates must be YYYY-MM-DD" }, { status: 400 });
    }
    if (from > to) {
      return NextResponse.json({ error: "`from` must be on or before `to`" }, { status: 400 });
    }
  }

  const report = await getLandingPageReport({
    orgId: auth.orgId,
    offerId,
    from,
    to,
    splitByBrand: sp.get("split_brand") === "1",
  });
  if (!report) return NextResponse.json({ error: "Offer not found" }, { status: 404 });
  return NextResponse.json({ report });
}
