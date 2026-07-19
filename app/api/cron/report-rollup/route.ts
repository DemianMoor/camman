import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { withCronLease } from "@/lib/cron/lease";
import { refreshReportRollup } from "@/lib/reporting/rollup";

// Reports rollup maintenance (migration 0112). Recomputes the 14-day unsettled
// window of both hourly-bucket fact tables and freezes older buckets. The
// bounded rolling-window UPSERT logic lives in refreshReportRollup; this route
// only schedules it under a single-runner lease.
//
// SHARED cron_locks ROW (by design): job_name 'report-rollup' is used by BOTH
// withCronLease (its `lease_until` column, serializing runs) AND
// refreshReportRollup (its `watermark` column, last-refresh stamp) on the same
// row — they compose because they touch distinct columns. Same pattern as
// /api/cron/propagate-clickers.
//
// Scheduled at 14,29,44,59 — just after the opt-out (…6/21…), conversions
// (…9/24…) and offer-reach (…12/27…) pollers each quarter-hour, so the rollup
// picks up freshly-polled engagement.
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const preferredRegion = "fra1"; // co-located with Supabase; pure DB work.

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const outcome = await withCronLease("report-rollup", () =>
      refreshReportRollup(db),
    );
    if (!outcome.ran) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        skippedCount: outcome.skippedCount,
      });
    }
    const r = outcome.result;
    console.log(
      `[report-rollup] ok stage_upserted=${r.stageRowsUpserted} group_upserted=${r.groupRowsUpserted} stage_settled=${r.stageRowsSettled} group_settled=${r.groupRowsSettled}`,
    );
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[report-rollup] FAILED:", err);
    return NextResponse.json(
      { error: "report_rollup_failed", detail: message },
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
