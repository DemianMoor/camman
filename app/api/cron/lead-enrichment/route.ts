import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { withCronLease } from "@/lib/cron/lease";
import { runEnrichmentBatch } from "@/lib/drip/enrichment";
import { can } from "@/lib/permissions";
import { HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";

// Drip lead enrichment sweeper (Drip Phase 3). ZERO SENDS.
//
// Drains lead_inbox: normalize → Telnyx lookup through the EXISTING queue →
// landline discarded / mobile-voip-unknown saved as contacts. Nothing here can
// message anyone; the send path is Phase 5.
//
// Auth + lease mirror /api/cron/tells-sweep exactly: CRON_SECRET Bearer for the
// scheduled run, or an authenticated operator+ session for a manual trigger.
//
// ⚠️ The heartbeat is stamped AFTER the work, so a run that threw does not look
// healthy — and it is checked by a DIFFERENT job (/api/cron/drip-monitors),
// never by this one. A sweeper that reports on its own liveness tells you
// nothing when it is the thing that died.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  if (!bearerMatches) {
    const auth = await requireApiMembership();
    if ("error" in auth) return auth.error;
    // Same gate as the other intake-side sweepers.
    if (!can(auth.role, "result_imports.create")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // Manual trigger: run without the lease, as every other manual cron
    // trigger does — rare, human-initiated, and must not silently no-op behind
    // a running cron.
    const result = await runEnrichmentBatch();
    return NextResponse.json(result);
  }

  const leased = await withCronLease("lead-enrichment", () => runEnrichmentBatch());
  if (!leased.ran) {
    return NextResponse.json({
      skipped: true,
      reason: "prior_run_in_progress",
      skippedCount: leased.skippedCount,
    });
  }
  await recordHeartbeat(db, HEARTBEAT_JOBS.leadEnrichment.job_name);
  return NextResponse.json(leased.result);
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
