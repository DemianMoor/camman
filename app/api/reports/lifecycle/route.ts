import { NextResponse, type NextRequest } from "next/server";

import { requireApiMembership } from "@/lib/api/helpers";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { can } from "@/lib/permissions";
import { getLifecycleReport } from "@/lib/reporting/lifecycle-report";

// Read API for /reports/lifecycle — per-cohort performance by send date (PR 5).
// Gated on campaigns.view, matching Overview and the other report routes.
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Same cap as Overview. The query reads per-recipient rows rather than a
// rollup, so the ceiling is a cost limit here, unlike /reports/delivery.
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

  const report = await getLifecycleReport({ orgId: auth.orgId, from, to });
  return NextResponse.json(report);
}
