import { fromZonedTime } from "date-fns-tz";
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

// Read API for the five performance reports (Phase 2). Reads the pre-aggregated
// rollup fact tables (never a live scan of the base tables). Gated on
// campaigns.view — same read permission as the existing /reports (Keitaro) tab.
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 92;

function addOneDay(d: string): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

// ET wall-clock day start → UTC instant (DST-safe, mirrors the Keitaro route).
function etDayStartUtc(d: string): string {
  return fromZonedTime(`${d}T00:00:00`, CAMPAIGN_TIMEZONE).toISOString();
}

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

  const bounds = {
    fromUtc: etDayStartUtc(from),
    toUtc: etDayStartUtc(addOneDay(to)), // exclusive upper bound
    providerPhoneId,
  };

  const [report, providers] = await Promise.all([
    getPerformanceReport(auth.orgId, dimension, bounds),
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
