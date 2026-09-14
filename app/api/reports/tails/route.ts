import { NextResponse, type NextRequest } from "next/server";

import { requireApiMembership } from "@/lib/api/helpers";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { can } from "@/lib/permissions";
import { getConversionTails, isCalendarDay } from "@/lib/reporting/grading";

// Operator API (creative grading): tracker conversions dated one ET day, split into
// same-day and TAILS — conversions whose stage was sent on an earlier day. Daily
// grading is wrong without them (25% of sales landed after the send day over the
// 30 days to 2026-09-14). Read-only, aggregate-only.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership({ route: "reports/tails", method: "GET" });
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "campaigns.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const raw = req.nextUrl.searchParams.get("date");
  if (raw != null && !isCalendarDay(raw)) {
    return NextResponse.json({ error: "`date` must be a real YYYY-MM-DD day" }, { status: 400 });
  }
  const date = raw ?? formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  return NextResponse.json(await getConversionTails(auth.orgId, date));
}
