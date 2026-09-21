import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";
import { refreshOfferGroupReport } from "@/lib/reporting/offer-group-report";

export const dynamic = "force-dynamic";
// ⛔ maxDuration IS NOT THE BINDING LIMIT for this job. Prod's
// statement_timeout is 120000ms, a Supabase platform default (source
// `configuration file`) on every connection. Any single REFRESH past 120s is
// cancelled with SQLSTATE 57014 long before 300s is reached — so raising this
// number, or splitting the four views into four crons, cannot make one REFRESH
// shorter. The fix is on the connection instead: lib/reporting/refresh-session.ts
// gives this job a session-mode connection with its own statement_timeout
// (180s) and work_mem (384MB).
//
// Measured 2026-09-21 by reading back consecutive report_refresh_log stamps
// from the real 05:00 UTC run: group 107.5s, offer-totals 36.7s,
// audience-totals 0.95s. The group refresh was 12.5s from the 120s wall.
//
// 300s remains the right Vercel budget: it is ~2x the ~145s the four views
// cost today, and it is ABOVE the 180s per-statement timeout so the database
// cancels a runaway refresh first. That ordering is deliberate — a 57014
// throws and this route alerts on it, whereas a Vercel timeout kills the
// invocation with no catch and no alert. See docs/04-features/offer-group-report.md.
export const maxDuration = 300;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const durations = await refreshOfferGroupReport();
    const refreshed = durations.outcomes.filter((o) => o.ok).map((o) => o.view);
    const failures = durations.outcomes.filter((o) => !o.ok);

    // Log runtime every run so we can watch it against the 180s per-statement
    // timeout and the 300s ceiling.
    console.log(
      `[refresh-offer-group-report] ${failures.length === 0 ? "ok" : "PARTIAL"} ` +
        `totalsMs=${durations.totalsMs} summaryMs=${durations.summaryMs} groupMs=${durations.groupMs} ` +
        `audienceTotalsMs=${durations.audienceTotalsMs} totalMs=${durations.totalMs} ` +
        `refreshed=${refreshed.length}/${durations.outcomes.length}`,
    );

    if (failures.length > 0) {
      // A PARTIAL run. The views that DID refresh are live and stamped; only
      // the failed ones are stale. Report it loudly — one alert naming every
      // failure, not one per view — and 500 so the scheduler flags red too.
      await notifyTelegram(
        `🔴 Tier-1: offer-group-report matview refresh PARTIAL — ` +
          `${failures.length} of ${durations.outcomes.length} views failed after ` +
          `${(durations.totalMs / 1000).toFixed(1)}s\n` +
          `Refreshed: ${refreshed.join(", ") || "(none)"}\n` +
          failures
            .map((f) => `Failed: ${f.view} after ${(f.durationMs / 1000).toFixed(1)}s — ${f.error}`)
            .join("\n"),
      );
      return NextResponse.json(
        {
          ok: false,
          error: "refresh_partial",
          refreshed,
          failed: failures.map((f) => ({
            view: f.view,
            durationMs: f.durationMs,
            error: f.error,
          })),
          durations,
        },
        { status: 500 },
      );
    }

    // Stamped only when ALL FOUR refreshes succeeded — the heartbeat must mean
    // "every report is fresh", not "the route was reached" and not "some of it
    // worked". Per-view freshness lives in report_refresh_log, which each view
    // stamps for itself.
    await recordHeartbeat(db, HEARTBEAT_JOBS.offerReportRefresh.job_name);
    return NextResponse.json({ ok: true, refreshed, failed: [], durations });
  } catch (err) {
    // WHOLE-JOB failure only. Individual view failures no longer reach here —
    // they are caught per view and reported as a PARTIAL above. What lands here
    // is everything that stops the job before any view can refresh: the
    // session-mode connection failing to open, the settings read-back guard in
    // refresh-session.ts refusing, or an unexpected throw.
    //
    // Fire a Tier-1 Telegram alert with duration + error, then surface a 500 so
    // the scheduler flags red too. notifyTelegram is best-effort (never
    // throws); awaiting it ensures delivery before the serverless invocation
    // ends.
    const elapsedMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[refresh-offer-group-report] FAILED after ${elapsedMs}ms:`,
      err,
    );
    await notifyTelegram(
      `🔴 Tier-1: offer-group-report matview refresh FAILED after ${(
        elapsedMs / 1000
      ).toFixed(1)}s\nError: ${message}`,
    );
    return NextResponse.json(
      { error: "refresh_failed", detail: message },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
