import { NextResponse, type NextRequest } from "next/server";

import { requireApiMembership } from "@/lib/api/helpers";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { can } from "@/lib/permissions";
import {
  getOptOutCohorts,
  isCalendarDay,
  isOptOutDimension,
  OPT_OUT_DIMENSIONS,
} from "@/lib/reporting/grading";

// Operator API (creative grading): the send-day cohort opt-out rate per ET day per
// sending number / campaign / stage / contact group — the STOPs credited to the
// messages SENT that day, divided by those messages. Number-level daily opt is a
// hard operating ceiling, and only org totals existed before. Read-only.
export const dynamic = "force-dynamic";
// The number dimension measured 11.8s for 7 days (2026-09-14); 14 days ≈ 24s.
export const maxDuration = 60;

const MAX_RANGE_DAYS = 14;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership({ route: "reports/opt-outs", method: "GET" });
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "campaigns.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const dimension = sp.get("dimension");
  if (!isOptOutDimension(dimension)) {
    return NextResponse.json(
      { error: `\`dimension\` must be one of: ${OPT_OUT_DIMENSIONS.join(", ")}` },
      { status: 400 },
    );
  }
  const granularity = sp.get("granularity");
  if (granularity != null && granularity !== "day") {
    return NextResponse.json({ error: "`granularity` supports only `day`" }, { status: 400 });
  }

  const today = formatInCampaignTimezone(new Date(), "yyyy-MM-dd");
  const from = sp.get("from") ?? today;
  const to = sp.get("to") ?? today;
  if (!isCalendarDay(from) || !isCalendarDay(to)) {
    return NextResponse.json(
      { error: "`from` and `to` must be real YYYY-MM-DD days" },
      { status: 400 },
    );
  }
  if (from > to) {
    return NextResponse.json({ error: "`from` must be on or before `to`" }, { status: 400 });
  }
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > MAX_RANGE_DAYS) {
    return NextResponse.json(
      { error: `The range can cover at most ${MAX_RANGE_DAYS} days` },
      { status: 400 },
    );
  }

  return NextResponse.json(await getOptOutCohorts(auth.orgId, dimension, from, to));
}
