import { NextResponse, type NextRequest } from "next/server";

import { requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import {
  DEFAULT_RECENT_DAYS,
  MAX_RECENT_DAYS,
  getGroupLifecycleBreakdown,
  getGroupLifecycleRollups,
} from "@/lib/reporting/group-lifecycle";

// Contact group × lifecycle, for sizing a daily campaign. Read-only.
//
// ⚠️ TWO PARTS, TWO REQUESTS, AND THE SPLIT IS MEASURED. `part=table` is the
// per-group grid and lands inside the 2s bar (median 1,812ms, worst 1,863ms on
// production over five runs). `part=rollups` is the cluster unions and the
// distinct footer, which need DISTINCT contacts across ~1.1M membership rows
// and cost median 6,311ms / worst 9,369ms. Serving them together would put the
// whole screen behind the slower half; split, the operator reads per-group
// numbers in under two seconds and the rollups arrive after.
export const dynamic = "force-dynamic";
// Above the rollups' worst measured run with room to spare.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership({
    route: "reports/group-lifecycle",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  // Same gate as the other audience reports: reading group sizes is reading
  // the audience, not the campaigns.
  if (!can(auth.role, "contacts.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const rawDays = Number(sp.get("days"));
  const recentDays =
    Number.isFinite(rawDays) && rawDays >= 1
      ? Math.min(Math.floor(rawDays), MAX_RECENT_DAYS)
      : DEFAULT_RECENT_DAYS;

  const part = sp.get("part") === "rollups" ? "rollups" : "table";
  const data =
    part === "rollups"
      ? await getGroupLifecycleRollups({ orgId: auth.orgId, recentDays })
      : await getGroupLifecycleBreakdown({ orgId: auth.orgId, recentDays });

  return NextResponse.json({ part, ...data });
}
