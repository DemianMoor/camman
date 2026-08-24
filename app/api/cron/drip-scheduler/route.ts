import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { withCronLease } from "@/lib/cron/lease";
import { runDripSchedulerBatch } from "@/lib/drip/scheduler";
import { can } from "@/lib/permissions";
import { checkHeartbeats, HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";

// Drip scheduler (Drip Phase 5).
//
// Turns due journeys into PENDING stage_sends rows. It does not send anything —
// the existing drain does, unmodified (G1).
//
// ⚠️ Gated on drip POSTURE. With org_settings.drip_enabled false (its production
// value) runDripSchedulerBatch returns after ONE read, so this ships live and
// completely inert. That is the point of the flag.
//
// ⚠️ It also CLOSES THE P3 GAP: drip-monitors watches the sweeper and the
// routing worker but was itself unwatched. This job checks its heartbeat, giving
// the same mutual dead-man arrangement tells-sweep/tells-monitors uses — a
// watcher nobody watches is silent in exactly the case that matters.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  if (!bearerMatches) {
    const auth = await requireApiMembership();
    if ("error" in auth) return auth.error;
    if (!can(auth.role, "campaigns.update")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json(await runDripSchedulerBatch());
  }

  const leased = await withCronLease("drip-scheduler", async () => {
    const result = await runDripSchedulerBatch();
    // The watcher-of-the-watcher half.
    const heartbeats = await checkHeartbeats(db, [HEARTBEAT_JOBS.dripMonitors]);
    return { ...result, heartbeats };
  });
  if (!leased.ran) {
    return NextResponse.json({
      skipped: true, reason: "prior_run_in_progress", skippedCount: leased.skippedCount,
    });
  }
  await recordHeartbeat(db, HEARTBEAT_JOBS.dripScheduler.job_name);
  return NextResponse.json(leased.result);
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
