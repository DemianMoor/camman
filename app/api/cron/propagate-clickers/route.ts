import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { withCronLease } from "@/lib/cron/lease";
import { propagateTrackedClickers } from "@/lib/links/propagate-clickers";

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
export const maxDuration = 60;
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

  try {
    const outcome = await withCronLease("propagate-clickers", () =>
      propagateTrackedClickers(db),
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
    console.log(
      `[propagate-clickers] ok inserted=${r.inserted} watermark=${r.watermarkFrom ?? "null"} -> ${r.watermarkTo ?? "null"}`,
    );
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
