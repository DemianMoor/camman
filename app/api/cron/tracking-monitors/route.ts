import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { clearAlert, notifyOnTransition } from "@/lib/alerts/alert-state";
import { requireApiMembership } from "@/lib/api/helpers";
import { can } from "@/lib/permissions";
import { HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";
import {
  formatTrackingGapAlert,
  runTrackingGapMonitor,
  trackingGapAlertKey,
} from "@/lib/reporting/tracking-gap";

// Keitaro tracking-gap monitor.
//
// A landing page missing its Keitaro visit script produces NO other symptom:
// sends succeed, DLRs arrive, redirects may even keep landing, and the Overview
// tab renders "Clickers 0" as though nobody clicked. This job is the only thing
// that notices.
//
// Breach-only, latched per stage: a periodic all-clear trains people to ignore
// the channel, and an unlatched threshold check would page every hour for as
// long as the condition held. Auth mirrors /api/cron/tells-monitors.
// The alert key, message formatter, and the no-visits predicate live in
// lib/reporting/tracking-gap.ts rather than here — they're shared with
// app/api/keitaro/reports/route.ts and the verify scripts, so they belong in
// lib/, not duplicated into this route module.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  // Org scope for the human path only. The bearer/cron path stays cross-org
  // (undefined orgId) — it must watch every org. A signed-in session only
  // ever gets its own org's breach rows.
  let orgId: string | undefined;

  if (!bearerMatches) {
    const auth = await requireApiMembership();
    if ("error" in auth) return auth.error;
    if (!can(auth.role, "campaigns.view")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    orgId = auth.orgId;
  }

  const report = await runTrackingGapMonitor(db, { orgId });

  // Only the scheduler notifies. A human hitting this route gets the findings in
  // the response body without spraying the channel.
  if (bearerMatches) {
    for (const b of report.breaches) {
      // notifyOnTransition is best-effort by contract and swallows its own
      // errors, so one bad stage cannot stop the rest from being evaluated.
      await notifyOnTransition(db, {
        alertKey: trackingGapAlertKey(b.stage_id),
        orgId: b.org_id,
        text: formatTrackingGapAlert(b),
      });
    }
    // Re-arm stages that recovered, so a stage that regresses after a fix can
    // alert again. Without this the latch is a one-shot for the life of the row.
    for (const { stage_id, org_id } of report.clean_stages) {
      await clearAlert(db, { alertKey: trackingGapAlertKey(stage_id), orgId: org_id });
    }
    // Stamp AFTER the work, so a run that threw does not look healthy.
    await recordHeartbeat(db, HEARTBEAT_JOBS.trackingMonitors.job_name);
  }

  return NextResponse.json(report);
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
