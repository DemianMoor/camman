import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";
import { refreshOfferGroupReport } from "@/lib/reporting/offer-group-report";

export const dynamic = "force-dynamic";
// COST. Two measurements exist, of two different things. Neither is "~104s on
// 2026-08-13" — that conflation is what this comment used to say; ~104s came
// from the Task 5 brief with no date and no breakdown behind it.
//
//  1. 2026-08-13, REFRESH durations logged by this route, PRE-ledger structure:
//     summary ~11s, group ~25s, offer-totals ~4.5s ≈ ~40.5s (the same figures
//     still at lib/reporting/offer-group-report.ts, plus 0180's audience totals).
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
// Nothing individually approaches the 300s ceiling, but the group matview's
// sort spills (`external merge  Disk: ~169MB`), so work_mem is the first knob
// if this grows. **Capture the real post-ledger number from the first prod run
// after 0181-0183 apply and the backfill completes** (Task 8's ⛔ block, step
// 2b — that refresh has to happen there anyway, because the matviews are built
// from an empty ledger at apply time) and add it here as measurement 3.
//
// 60s left no cold-start headroom, so this cron gets a larger budget. It is a
// background job (not user-facing), so a longer ceiling costs nothing;
// per-view durations are logged every run.
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
    // Stamped only on success, and only after all three refreshes have
    // completed — the heartbeat must mean "fresh data", not "the route was
    // reached".
    await recordHeartbeat(db, HEARTBEAT_JOBS.offerReportRefresh.job_name);
    // Log runtime every run so we can watch it grow toward the 300s ceiling.
    console.log(
      `[refresh-offer-group-report] ok totalsMs=${durations.totalsMs} summaryMs=${durations.summaryMs} groupMs=${durations.groupMs} audienceTotalsMs=${durations.audienceTotalsMs} totalMs=${durations.totalMs}`,
    );
    return NextResponse.json({ ok: true, durations });
  } catch (err) {
    // Previously this failed silently against a growing ~27s refresh. Fire a
    // Tier-1 Telegram alert with duration + error, then surface a 500 so the
    // scheduler flags red too. notifyTelegram is best-effort (never throws);
    // awaiting it ensures delivery before the serverless invocation ends.
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
