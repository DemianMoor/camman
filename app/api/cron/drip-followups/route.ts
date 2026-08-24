import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { withCronLease } from "@/lib/cron/lease";
import { runDripFollowups } from "@/lib/drip/followups";
import { can } from "@/lib/permissions";
import { recordHeartbeat, HEARTBEAT_JOBS } from "@/lib/reporting/cron-heartbeat";

// Behavioural follow-ups (Drip Phase 6).
//
// Turns DUE follow-ups into PENDING stage_sends rows, exactly as the first-send
// scheduler does, and lets the existing drain send them — same mint, same
// opt-out gate, same quiet hours, same breakers, drain.ts still unmodified (G1).
//
// ⚠️ SEPARATE FROM drip-scheduler ON PURPOSE. First-sends are latency-sensitive
// (a partner lead should be messaged within minutes) while follow-ups are due on
// timers measured in hours. Sharing one job would put a 200-row follow-up sweep
// in front of a lead that just arrived, and one slow pass would delay both.
//
// ⚠️ Gated on drip POSTURE: with org_settings.drip_enabled false — its
// production value — runDripFollowups returns after one read per org and this
// ships completely inert.
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
    return NextResponse.json(await runDripFollowups());
  }

  const leased = await withCronLease("drip-followups", async () => {
    return await runDripFollowups();
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
