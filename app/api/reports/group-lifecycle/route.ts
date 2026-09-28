import { NextResponse, type NextRequest } from "next/server";

import { requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import {
  computeGroupLifecycleNow,
  readStoredGroupLifecycle,
} from "@/lib/reporting/group-lifecycle-store";
import {
  DEFAULT_RECENT_DAYS,
  MAX_RECENT_DAYS,
} from "@/lib/reporting/group-lifecycle-types";

// Contact group x lifecycle, for sizing a daily campaign. Read-only.
//
// ⚠️ THE DEFAULT PATH READS A STORED TABLE (migration 0193), written by the
// engagement job every 15 minutes. Computing it on read cost 15-36s across two
// requests; reading ~126 rows is a few milliseconds.
//
// Two ways to get a live number, and both are explicit:
//   ?refresh=1   the "Refresh now" button — recomputes and STORES (N = 3)
//   ?days=N      any N other than 3 — recomputes and does NOT store, because
//                the store answers for N = 3 and writing another N into it
//                would leave the next page load showing a number for a
//                question nobody asked, under a fresh-looking timestamp
export const dynamic = "force-dynamic";
// The stored read needs milliseconds; a refresh recomputes the whole thing.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership({
    route: "reports/group-lifecycle",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "contacts.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const rawDays = Number(sp.get("days"));
  const recentDays =
    Number.isFinite(rawDays) && rawDays >= 1
      ? Math.min(Math.floor(rawDays), MAX_RECENT_DAYS)
      : DEFAULT_RECENT_DAYS;
  const refresh = sp.get("refresh") === "1";

  const data =
    refresh || recentDays !== DEFAULT_RECENT_DAYS
      ? await computeGroupLifecycleNow({ orgId: auth.orgId, recentDays })
      : await readStoredGroupLifecycle({ orgId: auth.orgId });

  return NextResponse.json(data);
}
