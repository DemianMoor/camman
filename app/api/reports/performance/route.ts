import { type NextRequest, NextResponse } from "next/server";

import { requireApiMembership } from "@/lib/api/helpers";
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { can } from "@/lib/permissions";
import {
  getPerformanceReport,
  getReportProviderOptions,
} from "@/lib/reporting/performance-report";
import {
  REPORT_DIMENSIONS,
  type ReportDimension,
} from "@/lib/reporting/report-dimensions";

// Read API for the five performance reports. Number/offer/sequence/group source
// from the shared per-stage Keitaro funnel (matches the Overview tab); hourly
// buckets by user-activity time. Gated on campaigns.view (same as Overview).
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 92;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "campaigns.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;

  const dimensionRaw = sp.get("dimension") ?? "";
  if (!REPORT_DIMENSIONS.includes(dimensionRaw as ReportDimension)) {
    return NextResponse.json(
      { error: `Unknown dimension. Expected one of: ${REPORT_DIMENSIONS.join(", ")}` },
      { status: 400 },
    );
  }
  const dimension = dimensionRaw as ReportDimension;

  const todayEt = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  const fromRaw = sp.get("from");
  const toRaw = sp.get("to");
  const from = fromRaw && DATE_RE.test(fromRaw) ? fromRaw : todayEt;
  // The hourly report is single-day by definition — clamp `to` to `from`.
  let to = toRaw && DATE_RE.test(toRaw) ? toRaw : todayEt;
  if (dimension === "hourly") to = from;

  if (from > to) {
    return NextResponse.json(
      { error: "`from` must be on or before `to`" },
      { status: 400 },
    );
  }
  const spanDays =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (spanDays > MAX_RANGE_DAYS) {
    return NextResponse.json(
      { error: `Date range cannot exceed ${MAX_RANGE_DAYS} days` },
      { status: 400 },
    );
  }

  const providerRaw = sp.get("provider_phone_id");
  const providerPhoneId =
    providerRaw && /^\d+$/.test(providerRaw) ? Number(providerRaw) : null;

  const [report, providers] = await Promise.all([
    getPerformanceReport(auth.orgId, dimension, { from, to, providerPhoneId }),
    getReportProviderOptions(auth.orgId),
  ]);

  return NextResponse.json({
    dimension,
    data: report.rows,
    totals: report.totals,
    refreshedAt: report.refreshedAt,
    providers,
    range: { from, to, timezone: CAMPAIGN_TIMEZONE },
  });
}
