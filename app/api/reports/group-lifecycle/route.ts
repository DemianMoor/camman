import { NextResponse, type NextRequest } from "next/server";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { isStatementTimeout } from "@/lib/db/statement-timeout";
import { can } from "@/lib/permissions";
import {
  computeGroupLifecycleLive,
  readStoredGroupLifecycle,
} from "@/lib/reporting/group-lifecycle-store";
import {
  DEFAULT_RECENT_DAYS,
  MAX_RECENT_DAYS,
} from "@/lib/reporting/group-lifecycle-types";

// Contact group x lifecycle, for sizing a daily campaign. READ-ONLY: nothing
// on this route writes.
//
// ⚠️ THE DEFAULT PATH READS A STORED TABLE (migration 0193), written by the
// hourly /api/cron/refresh-group-lifecycle and by the "Refresh now" button
// (POST /api/reports/group-lifecycle/refresh). Reading ~126 rows is a few
// milliseconds.
//
//   ?days=N   any N other than 3 — computed for this request and NOT stored,
//             because the store answers for N = 3 and writing another N into
//             it would leave the next page load showing a number for a
//             question nobody asked, under a fresh-looking timestamp
//
// ⚠️ There is no `?refresh=1` any more (2026-11-13). Recomputing the store is
// a write, and a GET that writes is one any prefetch, crawler or token holder
// can trigger; it lives on the POST route, under the cron's lease.
export const dynamic = "force-dynamic";
// The stored read needs milliseconds; an N ≠ 3 recomputes the whole thing.
export const maxDuration = 60;
// Below maxDuration, so a slow N ≠ 3 compute ends in a 57014 this route turns
// into a JSON error rather than a Vercel 504.
const LIVE_BUDGET_MS = 50_000;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership({
    route: "reports/group-lifecycle",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  // ⚠️ contacts.stats, NOT contacts.view. This report shows audience SIZE and
  // never a contact row, and those are deliberately separate grants
  // (869et3vm1 Phase 2: "how many" and "who" stopped being the same
  // permission). Gated on contacts.view it returned 403 to the OPERATOR role,
  // which is the role that sizes the daily sends.
  if (!can(auth.role, "contacts.stats")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const rawDays = Number(sp.get("days"));
  const recentDays =
    Number.isFinite(rawDays) && rawDays >= 1
      ? Math.min(Math.floor(rawDays), MAX_RECENT_DAYS)
      : DEFAULT_RECENT_DAYS;

  if (recentDays === DEFAULT_RECENT_DAYS) {
    return NextResponse.json(await readStoredGroupLifecycle({ orgId: auth.orgId }));
  }
  try {
    return NextResponse.json(
      await computeGroupLifecycleLive({
        orgId: auth.orgId,
        recentDays,
        budgetMs: LIVE_BUDGET_MS,
      }),
    );
  } catch (err) {
    if (isStatementTimeout(err)) {
      return apiError(
        504,
        `Computing the ${recentDays}-day figure stopped at the ${LIVE_BUDGET_MS / 1000} s limit. Try again in a few minutes, or use the stored 3-day figure.`,
        "statement_timeout",
      );
    }
    throw err;
  }
}
