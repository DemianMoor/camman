import { NextResponse, type NextRequest } from "next/server";

import { requireApiMembership } from "@/lib/api/helpers";
import { formatInCampaignTimezone } from "@/lib/campaign-timezone";
import { can } from "@/lib/permissions";
import { getLifecycleReport } from "@/lib/reporting/lifecycle-report";

// Read API for /reports/lifecycle — per-cohort performance by send date (PR 5).
// Gated on campaigns.view, matching Overview and the other report routes.
export const dynamic = "force-dynamic";
// A 14-day window measured ~34s on production, and the cap above is set to keep
// the worst case inside this.
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ⚠️ 14 DAYS, NOT OVERVIEW'S 92 — AND THE NUMBER IS MEASURED, NOT CHOSEN.
// Cohort CTR needs "did this (stage, contact) click", which is per-recipient
// over links + clicks; there is no rollup for it. Measured on production:
//
//   2d ~13-19s · 5d ~18s · 7d ~21-26s · 14d ~34s
//
// (Ranges, not points: repeats of identical code on a 7-day window spanned
// 20.8-25.5s, so single runs cannot be compared to each other.) Linear, with a
// large constant, so 92 days would be minutes. A cap the route cannot serve is
// worse than a smaller one: the request would burn the whole maxDuration and
// return a 504 with nothing to show for it. 14 fits inside the 60s limit below
// even at the slow end of that spread.
//
// Widening this means changing where the clicks come from — counted_clickers
// answers the same question in one indexed lookup, and that is the owner's
// decision to make (they chose raw HUMAN_CLICK deliberately, for source
// consistency with the engine), not one to take here.
const MAX_RANGE_DAYS = 14;
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
