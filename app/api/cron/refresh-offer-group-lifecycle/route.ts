import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";
import { refreshOfferGroupLifecycle } from "@/lib/reporting/offer-group-report";

export const dynamic = "force-dynamic";
// The Offer Group report's LIFECYCLE matviews — offer_group_lifecycle_v2_mv
// (0226, cohort sends) and offer_group_exposure_mv (0227, cohort exposure) —
// in their own cron run at 05:30 / 20:30 UTC, 30 minutes after the main
// refresh (/api/cron/refresh-offer-group-report). Owner, 2026-10-27: with the
// exposure view added, one run of all six views would sit at or past the 300 s
// route limit (the main run's group view alone peaked at 175.9 s).
//
// Same machinery as the main run: the report's session-mode connection
// (180 s statement_timeout, raised work_mem — lib/reporting/refresh-session.ts),
// each view refreshed CONCURRENTLY and caught on its own, each stamping its own
// report_refresh_log row. As there, the binding limit is the 180 s statement
// timeout, not maxDuration: the database cancels a runaway refresh first, and
// a 57014 is caught and alerted, where a Vercel timeout would end the
// invocation silently. Measured costs live in docs/04-features/offer-group-report.md.
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
    const durations = await refreshOfferGroupLifecycle();
    const refreshed = durations.outcomes.filter((o) => o.ok).map((o) => o.view);
    const failures = durations.outcomes.filter((o) => !o.ok);
    const { connection } = durations;

    console.log(
      `[refresh-offer-group-lifecycle] ${failures.length === 0 ? "ok" : "PARTIAL"} ` +
        `connection=${connection.mode} ` +
        `effectiveWorkMemKb=${connection.workMemKb} ` +
        `effectiveStatementTimeoutMs=${connection.statementTimeoutMs}` +
        (connection.fallbackReason ? ` fallbackReason=${connection.fallbackReason}` : "") +
        ` lifecycleMs=${durations.lifecycleMs} exposureMs=${durations.exposureMs} totalMs=${durations.totalMs} ` +
        `refreshed=${refreshed.length}/${durations.outcomes.length}`,
    );

    if (failures.length > 0) {
      await notifyTelegram(
        `🔴 Tier-1: offer-group LIFECYCLE matview refresh PARTIAL — ` +
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
          failed: failures.map((f) => ({ view: f.view, durationMs: f.durationMs, error: f.error })),
          durations,
        },
        { status: 500 },
      );
    }

    // Its OWN heartbeat, stamped only when both views refreshed — watched by
    // the daily counted-clickers rebuild alongside the main run's.
    await recordHeartbeat(db, HEARTBEAT_JOBS.offerLifecycleRefresh.job_name);
    return NextResponse.json({ ok: true, connection, refreshed, failed: [], durations });
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[refresh-offer-group-lifecycle] FAILED after ${elapsedMs}ms:`, err);
    await notifyTelegram(
      `🔴 Tier-1: offer-group LIFECYCLE matview refresh FAILED after ${(
        elapsedMs / 1000
      ).toFixed(1)}s\nError: ${message}`,
    );
    return NextResponse.json({ error: "refresh_failed", detail: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
