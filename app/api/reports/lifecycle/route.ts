import { NextResponse, type NextRequest } from "next/server";

import { requireApiMembership } from "@/lib/api/helpers";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { can } from "@/lib/permissions";
import { getLifecycleReportHybrid } from "@/lib/reporting/lifecycle-rollup";

// Read API for /reports/lifecycle — per-cohort performance by send date (PR 5).
// Gated on campaigns.view, matching Overview and the other report routes.
export const dynamic = "force-dynamic";
// A 14-day window measured ~34s on production, and the cap above is set to keep
// the worst case inside this.
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 92 days, the same as Overview — restored once the day rollup (migration 0192)
// existed to make it servable.
//
// It was 14 for one PR. The report reads per-recipient rows and measured
// 2d ~13-19s, 5d ~18s, 7d ~21-26s, 14d ~34s — linear with a large constant, so
// 92 days was minutes and a cap the route cannot serve returns a 504 with
// nothing to show. The rollup computes a day once; the read is now a summation
// over closed days plus ONE day computed live.
const MAX_RANGE_DAYS = 92;
const DEFAULT_RANGE_DAYS = 7;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership({
    route: "reports/lifecycle",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "campaigns.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const todayEt = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  const defaultFrom = formatInCampaignTimezone(
    new Date(Date.now() - (DEFAULT_RANGE_DAYS - 1) * 86_400_000),
    "yyyy-MM-dd",
  );
  const fromRaw = sp.get("from");
  const toRaw = sp.get("to");
  let from = fromRaw && DATE_RE.test(fromRaw) ? fromRaw : defaultFrom;
  let to = toRaw && DATE_RE.test(toRaw) ? toRaw : todayEt;
  if (from > to) [from, to] = [to, from];

  const spanDays =
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    return NextResponse.json(
      { error: `Range is capped at ${MAX_RANGE_DAYS} days` },
      { status: 400 },
    );
  }

  const report = await getLifecycleReportHybrid({ orgId: auth.orgId, from, to });
  return NextResponse.json(report);
}
