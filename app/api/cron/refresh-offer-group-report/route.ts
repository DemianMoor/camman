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
// COST OF THE LEDGER STRUCTURE (0183). Besides the 2026-09-21 refresh times
// above, two measurements exist, of two different things. Neither is "~104s on
// 2026-08-13" — that conflation is what this comment used to say; ~104s came
// from the Task 5 brief with no date and no breakdown behind it.
//
//  1. 2026-08-13, REFRESH durations logged by this route, PRE-ledger structure:
//     summary ~11s, group ~25s, offer-totals ~4.5s ≈ ~40.5s (the first three
//     matviews; 0180's audience totals came later).
//  2. 2026-09-18, read-only `EXPLAIN ANALYZE` on PROD of the three defining
//     SELECTs migration 0183 introduces, with the `conv` CTE stubbed from the
//     legacy columns because conversion_events does not exist on prod yet:
//     offer-totals 43.4s · group 116.7s · audience-totals 1.2s ≈ 161s.
//
// The two are NOT comparable and (2) is not a ceiling:
//   • (2) times the SELECT. A REFRESH also writes the new heap and rebuilds the
//     unique index, and this route refreshes CONCURRENTLY, which additionally
//     builds a transient table and diffs it. The real refresh costs MORE.
//   • EXPLAIN ANALYZE adds per-node timing overhead on a row-heavy plan.
//   • The stub scans all ~5M stage_sends rows for the 1,436 carrying a
//     converted_at; the real `conv` CTE aggregates ~1.5K indexed
//     conversion_events rows. So ~10s per matview is stub overhead the real
//     thing will not pay.
//   • (2) excludes offer_report_org_summary_mv, which 0183 does not touch.
//   • Prod data grew between the two dates (stage_sends is ~5M rows now).
//
// The group matview's sort spills (`external merge  Disk: ~169MB`) — one reason
// the session above raises work_mem. **Capture the real post-ledger number from
// the first prod run after 0181-0183 apply and the backfill completes** (Task
// 8's ⛔ block, step 2b — that refresh has to happen there anyway, because the
// matviews are built from an empty ledger at apply time) and add it here as
// measurement 3. The budget it has to fit is the 180s per-statement timeout
// above, not the 300s ceiling.
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
    const { connection } = durations;

    // Log runtime every run so we can watch it against the 180s per-statement
    // timeout and the 300s ceiling — and log WHICH CONNECTION did the work plus
    // the settings ACTUALLY in force on it, never the values we intended. After
    // a manual trigger this one line answers "did the fix apply?" on its own.
    console.log(
      `[refresh-offer-group-report] ${failures.length === 0 ? "ok" : "PARTIAL"} ` +
        `connection=${connection.mode} ` +
        `effectiveWorkMemKb=${connection.workMemKb} ` +
        `effectiveStatementTimeoutMs=${connection.statementTimeoutMs}` +
        (connection.fallbackReason ? ` fallbackReason=${connection.fallbackReason}` : "") +
        ` totalsMs=${durations.totalsMs} summaryMs=${durations.summaryMs} groupMs=${durations.groupMs} ` +
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
          connection,
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
    // `connection` is top-level as well as inside `durations` so a manual
    // trigger can read session-vs-pooled and the effective settings without
    // digging.
    return NextResponse.json({ ok: true, connection, refreshed, failed: [], durations });
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
