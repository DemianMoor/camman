import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { withCronLease } from "@/lib/cron/lease";
import { can } from "@/lib/permissions";
import { pollOptOuts } from "@/lib/sends/poll-opt-outs";

// Inbound opt-out (STOP) intake by polling TextHub's `?inbox=true`.
//
// Auth is DUAL:
//   - CRON_SECRET Bearer (Vercel Cron, see vercel.json) -> polls ALL orgs'
//     credentials. GET, matching the score-pending cron pattern.
//   - Authenticated session with operator+ (opt_outs.upload) -> polls only the
//     caller's org. POST, used by the "Poll opt-outs now" button.
// Neither => 401/403. The browser uses its session cookie, so CRON_SECRET is
// never exposed to the client.
export const dynamic = "force-dynamic";
// Raised from 60s: the poller now walks multiple inbox pages per credential to
// drain TextHub's retained paginated window (see pollCredential). Per-credential
// time budgets (PER_CREDENTIAL_BUDGET_MS) keep the total under this ceiling.
export const maxDuration = 120;
// Pin to Frankfurt (eu-central-1), co-located with Supabase, so the thousands
// of sequential DB round-trips this job makes don't cross the Atlantic (~90ms
// each). Per-route only — do NOT set a global region; US-facing routes such as
// the /r/[code] redirect must stay in the US region.
export const preferredRegion = "fra1";

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches =
    !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  let orgId: string | undefined;
  if (!bearerMatches) {
    const auth = await requireApiMembership();
    if ("error" in auth) return auth.error;
    if (!can(auth.role, "opt_outs.upload")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    orgId = auth.orgId; // scope the manual poll to the caller's org
  }

  // Scheduled (cron) runs poll ALL orgs and are single-runner: a prior tick
  // whose per-message transactions are still draining server-side after a
  // timeout-kill must not get piled on. The manual button (org-scoped) bypasses
  // the lease so it never silently no-ops behind a running cron.
  if (bearerMatches) {
    const leased = await withCronLease("opt-outs-poll", () =>
      pollOptOuts(db, { orgId }),
    );
    if (!leased.ran) {
      return NextResponse.json({
        skipped: true,
        reason: "prior_run_in_progress",
        skippedCount: leased.skippedCount,
      });
    }
    return NextResponse.json(leased.result);
  }

  const result = await pollOptOuts(db, { orgId });
  return NextResponse.json(result);
}

// Cron (Bearer) hits GET; the manual button hits POST. Both share one handler.
export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
