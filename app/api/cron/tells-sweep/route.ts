import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { withCronLease } from "@/lib/cron/lease";
import { can } from "@/lib/permissions";
import { HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";
import { sweepTellsWebhookEvents } from "@/lib/sends/tells-sweep";

// Tells webhook sweeper — drains tells_webhook_events WHERE processed_at IS NULL.
//
// This is the guaranteed floor under §4.1's persist-first model: the webhook
// handlers process inline, but that attempt is best-effort by design (the row
// is committed first, so a failure there is recoverable). Tells has NO poll and
// NO reconciliation API, so this retry loop is the only recovery path — which
// is why neither Ahoi nor Text Request needs an equivalent.
//
// Auth + lease mirror /api/cron/ahoi-cdr-poll exactly: CRON_SECRET Bearer
// (Vercel Cron, all orgs) or an authenticated operator+ session (manual
// trigger, scoped to the caller's org).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  let orgId: string | undefined;
  if (!bearerMatches) {
    const auth = await requireApiMembership();
    if ("error" in auth) return auth.error;
    if (!can(auth.role, "result_imports.create")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    orgId = auth.orgId;
  }

  if (bearerMatches) {
    const leased = await withCronLease("tells-sweep", () => sweepTellsWebhookEvents(db, { orgId }));
    if (!leased.ran) {
      return NextResponse.json({
        skipped: true, reason: "prior_run_in_progress", skippedCount: leased.skippedCount,
      });
    }
    // Stamp AFTER the work, so a run that threw does not look healthy. This is
    // the heartbeat the MONITORS job checks (mutual dead-man watch, §4.5).
    // Safe to share the lease's cron_locks row: the lease writes `lease_until`,
    // this writes `watermark` — different columns.
    await recordHeartbeat(db, HEARTBEAT_JOBS.tellsSweep.job_name);
    return NextResponse.json(leased.result);
  }

  const result = await sweepTellsWebhookEvents(db, { orgId });
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
