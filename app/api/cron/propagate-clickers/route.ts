import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { withCronLease } from "@/lib/cron/lease";
import { propagateTrackedClickers } from "@/lib/links/propagate-clickers";
import { HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";

// Dedicated cron for tracked-clicker propagation (W1.1). This used to run
// best-effort at the tail of /api/clicks/score-pending, where a heavy scoring
// run ate the 60s function budget and starved it — the watermark stalled for
// hours (observed 2026-07-14: stuck ~5h while clicks kept scoring). Splitting it
// into its own scheduled function gives it an independent budget so it always
// runs. The incremental watermark logic ((watermark, now()-5min] window,
// advance-after-commit) lives in propagateTrackedClickers; this route only
// schedules it under a single-runner lease.
//
// SHARED cron_locks ROW (by design): job_name 'propagate-clickers' is used by
// BOTH withCronLease (its `lease_until` column, serializing runs) AND
// propagateTrackedClickers (its `watermark` column, tracking progress) on the
// same row. They compose because they touch distinct columns — the lease upsert
// never writes `watermark`, and propagate's own upsert never writes
// `lease_until`.
export const dynamic = "force-dynamic";
// ?mode=rebuild scans ALL history and takes materially longer than the
// incremental window, so the budget is raised for it.
export const maxDuration = 300;
// Pure DB work → pin to Frankfurt (co-located with Supabase), same as the
// scoring cron this was split out of. Per-route only.
export const preferredRegion = "fra1";

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ?mode=rebuild ignores the watermark and rescans all history — the repair
  // path for corrections that land behind the cursor (see propagate-clickers.ts).
  // ?dryRun=1 counts what would be inserted without writing.
  const mode = req.nextUrl.searchParams.get("mode") === "rebuild" ? "rebuild" : "incremental";
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  try {
    const outcome = await withCronLease("propagate-clickers", () =>
      propagateTrackedClickers(db, { mode, dryRun }),
    );
    if (!outcome.ran) {
      // Overlap with a prior run still holding the lease — expected backpressure.
      return NextResponse.json({
        ok: true,
        skipped: true,
        skippedCount: outcome.skippedCount,
      });
    }
    const r = outcome.result;
    // Log the SCOPE, not just the count. A result read without knowing what it
    // ran against is not evidence — see docs/07-conventions.md.
    console.log(
      `[propagate-clickers] ok mode=${r.mode}${r.dryRun ? " DRY-RUN" : ""} scope="${r.scope}" ` +
        `inserted=${r.inserted} watermark=${r.watermarkFrom ?? "null"} -> ${r.watermarkTo ?? "null"}`,
    );
    // Heartbeat only for a real weekly rebuild — the thing the monitors watch.
    if (mode === "rebuild" && !dryRun) {
      await recordHeartbeat(db, HEARTBEAT_JOBS.clickerRebuild.job_name);
    }
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[propagate-clickers] FAILED:", err);
    return NextResponse.json(
      { error: "propagate_failed", detail: message },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
