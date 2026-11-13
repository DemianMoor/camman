import { NextResponse } from "next/server";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { isStatementTimeout } from "@/lib/db/statement-timeout";
import { can } from "@/lib/permissions";
import {
  ON_DEMAND_BUDGET_MS,
  refreshGroupLifecycleOnDemand,
} from "@/lib/reporting/group-lifecycle-store";

// POST /api/reports/group-lifecycle/refresh — the report's "Refresh now".
//
// Recomputes the stored N = 3 table under the SAME per-org lease as the hourly
// /api/cron/refresh-group-lifecycle, so a click and the cron never compute at
// once (they did, 2026-11-13 10:10, when the button took no lease):
//
//   200 { outcome: "recomputed", ...table }  computed and stored now
//   200 { outcome: "reused", ...table }      a run finished < 2 min ago; nothing re-run
//   202 { outcome: "in_progress", computed_at }
//                                            another run holds the lease; nothing
//                                            started — the client polls the cheap
//                                            GET until computed_at moves past this
//
// A failure leaves the stored rows untouched (one transaction) and answers with
// a JSON error, never a bare Vercel 504: the compute's statement budget
// (ON_DEMAND_BUDGET_MS) is under maxDuration.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST() {
  const auth = await requireApiMembership({
    route: "reports/group-lifecycle/refresh",
    method: "POST",
  });
  if ("error" in auth) return auth.error;
  // Same grant as the GET the button used before (contacts.stats): who may
  // press it is unchanged.
  if (!can(auth.role, "contacts.stats")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const result = await refreshGroupLifecycleOnDemand({ orgId: auth.orgId });
    return NextResponse.json(result, {
      status: result.outcome === "in_progress" ? 202 : 200,
    });
  } catch (err) {
    if (isStatementTimeout(err)) {
      return apiError(
        504,
        `The recompute stopped at its ${ON_DEMAND_BUDGET_MS / 1000} s limit. The stored numbers were not changed — try again in a few minutes.`,
        "statement_timeout",
      );
    }
    console.error("[group-lifecycle/refresh] failed", {
      orgId: auth.orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return apiError(
      500,
      "The recompute failed. The stored numbers were not changed.",
      "internal",
    );
  }
}
