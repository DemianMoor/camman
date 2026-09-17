import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";
import { refreshOfferGroupReport } from "@/lib/reporting/offer-group-report";

export const dynamic = "force-dynamic";
// Last measured on prod data 2026-08-13 (pre-ledger structure): ~104s across the
// four matviews against this 300s ceiling (org summary + group + the 0132
// offer-totals matview + 0180's audience group totals) — see git history for the
// breakdown. Migration 0183 (Phase 3) restructured the group + offer-totals +
// audience-totals matviews to read per-recipient conversions from the
// conversion_events ledger instead of stage_sends columns; conversion_events does
// not exist on production yet (0181-0183 apply together at Task 8 Step 5 of the
// conversion-events-phase3 plan), so the new structure cannot be re-measured
// against real prod data until then. Capture the real number from that run's
// response (`durations`) and update this comment — do not carry the stale
// pre-ledger figure past that apply. 60s left no cold-start headroom, so this
// cron gets a larger budget. It is a background job (not user-facing), so a
// longer ceiling costs nothing; per-view durations are logged every run.
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
