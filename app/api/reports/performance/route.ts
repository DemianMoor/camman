import { NextResponse, type NextRequest } from "next/server";

import { requireApiMembership } from "@/lib/api/helpers";
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { can } from "@/lib/permissions";
import {
  getPerformanceReport,
  getReportProviderOptions,
  gradePerf,
} from "@/lib/reporting/performance-report";
import {
  ATTRIBUTION_BASES,
  isAttributionBasis,
  REPORT_DIMENSIONS,
  type ReportDimension,
} from "@/lib/reporting/report-dimensions";

// Read API for the five performance reports. Number/offer/sequence/group source
// from the shared per-stage Keitaro funnel (matches the Overview tab); hourly
// buckets by user-activity time. Gated on campaigns.view (same as Overview).
export const dynamic = "force-dynamic";
// A long attribution=send_date range counts every send of every cohort stage
// (~10s for 7 days, measured 2026-09-14); give it headroom over the default.
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 92;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership({
    route: "reports/performance",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "campaigns.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;

  const dimensionRaw = sp.get("dimension") ?? "";
  if (!REPORT_DIMENSIONS.includes(dimensionRaw as ReportDimension)) {
    return NextResponse.json({ error: `Unknown dimension. Expected one of: ${REPORT_DIMENSIONS.join(", ")}` },
      { status: 400 },
    );
  }
  const dimension = dimensionRaw as ReportDimension;

  const todayEt = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  const fromRaw = sp.get("from");
  const toRaw = sp.get("to");
  const from = fromRaw && DATE_RE.test(fromRaw) ? fromRaw : todayEt;
  // Hourly buckets by hour-of-day across the whole range (each hour summed over
  // all days), so it takes a from/to range like every other dimension.
  const to = toRaw && DATE_RE.test(toRaw) ? toRaw : todayEt;

  if (from > to) {
    return NextResponse.json({ error: "`from` must be on or before `to`" },
      { status: 400 },
    );
  }
  const spanDays =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (spanDays > MAX_RANGE_DAYS) {
    return NextResponse.json({ error: `Date range cannot exceed ${MAX_RANGE_DAYS} days` },
      { status: 400 },
    );
  }

  // conversion_date (default) = every metric on its own event day; send_date = the
  // cohort of stages sent in range, with everything they have produced to date.
  const attributionRaw = sp.get("attribution") ?? "conversion_date";
  if (!isAttributionBasis(attributionRaw)) {
    return NextResponse.json(
      { error: `Unknown attribution. Expected one of: ${ATTRIBUTION_BASES.join(", ")}` },
      { status: 400 },
    );
  }
  const attribution = attributionRaw;
  if (dimension === "hourly" && attribution === "send_date") {
    return NextResponse.json(
      { error: "hourly buckets by event time; attribution=send_date is not supported for it" },
      { status: 400 },
    );
  }

  const providerRaw = sp.get("provider_phone_id");
  const providerPhoneId =
    providerRaw && /^\d+$/.test(providerRaw) ? Number(providerRaw) : null;

  const [report, providers] = await Promise.all([
    getPerformanceReport(auth.orgId, dimension, { from, to, providerPhoneId, attribution }),
    getReportProviderOptions(auth.orgId),
  ]);

  return NextResponse.json({
    dimension,
    attribution,
    // Operator-API grading fields on every row and the totals (gradePerf).
    data: report.rows.map((r) => gradePerf(r)),
    totals: gradePerf(report.totals),
    refreshedAt: report.refreshedAt,
    providers,
    range: { from, to, timezone: CAMPAIGN_TIMEZONE },
  });
}
