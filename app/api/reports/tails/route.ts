import { NextResponse, type NextRequest } from "next/server";

import { requireApiMembership } from "@/lib/api/helpers";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { can } from "@/lib/permissions";
import { getConversionTails } from "@/lib/reporting/grading";

// Operator API (creative grading): tracker conversions dated one ET day, split into
// same-day and TAILS — conversions whose stage was sent on an earlier day. Daily
// grading is wrong without them (25% of sales landed after the send day over the
// 30 days to 2026-09-14). Read-only, aggregate-only.
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A real calendar day: the regex alone lets 2026-02-31 through to a Postgres 22008.
function isCalendarDay(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

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
