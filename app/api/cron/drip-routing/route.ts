import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { withCronLease } from "@/lib/cron/lease";
import { runDripRoutingBatch } from "@/lib/drip/routing";
import { can } from "@/lib/permissions";
import { HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";

// Drip routing worker (Drip Phase 4). ZERO SENDS.
//
// Assigns processed leads to exactly one drip campaign. Nothing here can message
// anyone — the scheduler that turns a journey into a send is Phase 5.
//
// Gated on drip POSTURE: with org_settings.drip_enabled false (every org today)
// runDripRoutingBatch returns immediately having read one row. So this cron can
// ship live and inert, which is the point of the flag.
//
// ⚠️ Heartbeat stamped AFTER the work, and checked by a DIFFERENT job
// (/api/cron/drip-monitors), never by this one.
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
    return NextResponse.json(await runDripRoutingBatch());
  }

  const leased = await withCronLease("drip-routing", () => runDripRoutingBatch());
  if (!leased.ran) {
    return NextResponse.json({
      skipped: true, reason: "prior_run_in_progress", skippedCount: leased.skippedCount,
    });
  }
  await recordHeartbeat(db, HEARTBEAT_JOBS.dripRouting.job_name);
  return NextResponse.json(leased.result);
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
