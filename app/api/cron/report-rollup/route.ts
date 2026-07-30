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
// UNSCHEDULED as of 2026-07-30 — removed from vercel.json's `crons`. The route
// is kept callable (manual/curl) but nothing invokes it automatically.
//
// Why: `report_stage_hour` / `report_group_hour` have no readers. The /reports
// tabs and the Overview route both source from lib/reporting/stage-funnel.ts
// (`getStageMetricsInRange`), and the Telegram report builds from its own
// queries — neither touches these tables. Verified four ways: repo-wide grep
// (only writes here + scripts/test-report-rollup.ts), no SELECT/FROM/JOIN
// against either table anywhere in app/ or lib/, and pg_stat_user_tables showing
// idx_scan (1,492,814) ≈ n_tup_upd (1,491,062) — i.e. the "reads" were the
// upsert's own ON CONFLICT probes, not consumers.
//
// Cost of keeping it: at 14,29,44,59 it was the #1 and #2 query by total DB time
// across the whole database — 7,159s + 6,358s = 3.75 HOURS — re-upserting the
// same ~3,900 live rows 1.7M times and reading ~355MB per burst, four times an
// hour. That I/O was competing with interactive requests.
//
// If reporting ever needs these tables, re-add the cron entry rather than
// reviving a second copy of this logic. Retiring the tables themselves needs a
// migration (and a ClickUp card) — deliberately not done here.
//
// Previous schedule, for reference: "14,29,44,59 * * * *" — just after the
// opt-out (…6/21…), conversions (…9/24…) and offer-reach (…12/27…) pollers each
// quarter-hour, so the rollup picked up freshly-polled engagement.
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
