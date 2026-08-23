import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { withCronLease } from "@/lib/cron/lease";
import { runDripMonitors } from "@/lib/drip/monitors";
import { can } from "@/lib/permissions";
import { checkHeartbeats, HEARTBEAT_JOBS } from "@/lib/reporting/cron-heartbeat";

// Drip monitors (Drip Phase 3).
//
// ⚠️ THIS IS A DIFFERENT JOB FROM THE ONE IT WATCHES, deliberately. It checks
// the lead-enrichment sweeper's heartbeat; the sweeper never checks its own. A
// job that reports on its own liveness is silent in the exact case that matters
// — when it has stopped running. Same mutual dead-man arrangement as
// tells-sweep / tells-monitors.
//
// Three things it watches, and they are NOT interchangeable:
//   * 'received' backlog     — the sweeper is behind or dead
//   * 'awaiting_lookup' pile — the Telnyx side is stuck (cap, balance, queue)
//   * Telnyx balance         — the top-up alert
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  if (!bearerMatches) {
    const auth = await requireApiMembership();
    if ("error" in auth) return auth.error;
    if (!can(auth.role, "result_imports.create")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const result = await runDripMonitors();
    return NextResponse.json(result);
  }

  const leased = await withCronLease("drip-monitors", async () => {
    const monitors = await runDripMonitors();
    // The dead-man half: is the sweeper's own heartbeat stale?
    const heartbeats = await checkHeartbeats(db, [HEARTBEAT_JOBS.leadEnrichment]);
    return { ...monitors, heartbeats };
  });

  if (!leased.ran) {
    return NextResponse.json({
      skipped: true,
      reason: "prior_run_in_progress",
      skippedCount: leased.skippedCount,
    });
  }
  return NextResponse.json(leased.result);
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
