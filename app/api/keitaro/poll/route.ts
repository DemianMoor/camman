import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { ingestKeitaroConversions, type IngestResult } from "@/lib/conversions/ingest";
import { liveIngestRange } from "@/lib/conversions/keitaro-row";
import { evaluateConversionAlerts, type IngestOutcome } from "@/lib/conversions/monitor";
import { withCronLease } from "@/lib/cron/lease";
import { pollKeitaro } from "@/lib/keitaro/poll";
import {
  changedLedgerStageIds,
  syncStageDayConversions,
  type StageDayConversionSync,
} from "@/lib/keitaro/stage-day-conversions";
import { can } from "@/lib/permissions";
import { refreshCountedClickers } from "@/lib/reporting/counted-clickers";
import { HEARTBEAT_JOBS, recordHeartbeat } from "@/lib/reporting/cron-heartbeat";

// Keitaro 5-minute poll. Vercel Cron hits this on a schedule (see vercel.json)
// with `Authorization: Bearer <CRON_SECRET>`. Also callable manually by an
// operator+ (e.g. to verify the live connection or force a refresh) — the
// manual path resolves the caller's org only for the permission check; the
// poll itself maps results to orgs by sub_id_3 either way.
//
// ?windowDays=N overrides the rolling lookback window (default 3) of the
// aggregate poll only. Each tick also keeps the conversion_events ledger live
// over its own 7-day window (ingestConversionLedger) and then re-derives the
// stage-day conversion columns of keitaro_stage_results from that ledger
// (syncStageDayConversions) — skipped when the ingest window was not complete.
export const dynamic = "force-dynamic";
// Must die before the cron lease (CRON_LEASE_MS, lib/cron/lease.ts) expires at
// 240s, or two ticks could overlap. Typical runs are low single-digit seconds;
// if a tick is killed at 230s, the ledger ingest's transaction rolls back and
// retries on the next tick.
export const maxDuration = 230;
// Pin to Frankfurt (eu-central-1), co-located with Supabase, so this job's DB
// round-trips don't cross the Atlantic (~90ms each). Per-route only — do NOT set
// a global region; US-facing routes such as the /r/[code] redirect stay in the US.
export const preferredRegion = "fra1";


// Conversion events ledger (Phase 2 — docs/04-features/conversion-events.md).
// Rides this tick AFTER the aggregate poll and the clicker refresh and is fully
// isolated from both: its own Keitaro fetch (the last 7 ET days, independent of
// ?windowDays), its own transaction, its own try/catch. It writes ONLY
// conversion_events — keitaro_stage_results and stage_sends are untouched — and
// a failure here never changes the poll's result.
//
// Alerts and the heartbeat are CRON-ONLY: a manual refresh still ingests but
// never pages and never vouches for the scheduled job's liveness. A THROWN
// ingest is a failed tick for alerting exactly like a refused window: it feeds
// the same debounced fetch_failed decision, with the thrown message as the
// error text. The unmapped and type_conflicts ledger alerts are evaluated on
// every cron tick, failed ones included (they read the table), and are keyed
// per problem combo (lib/conversions/monitor.ts): each new combo pages once,
// repeats never re-page, and a combo that disappears is cleared — unless its
// kind is past the LEDGER_MAX_COMBOS cap, where that kind's fixed
// combo_cap_exceeded key pages instead and no combo key of it clears. The heartbeat
// is stamped LAST and only for a complete (ok) window, so a tick that was
// refused, threw, or whose alert evaluation threw leaves it stale for
// /api/cron/tracking-monitors to notice.
async function ingestConversionLedger(
  isCron: boolean,
): Promise<{ result: IngestResult | null; error: string | null }> {
  const range = liveIngestRange(new Date());
  let outcome: IngestOutcome;
  try {
    outcome = { kind: "result", result: await ingestKeitaroConversions(db, { range }) };
  } catch (err) {
    console.error("[keitaro/poll] conversion ledger ingest failed", err);
    outcome = { kind: "threw", range, error: err instanceof Error ? err.message : String(err) };
  }
  const result = outcome.kind === "result" ? outcome.result : null;
  const ingestError = outcome.kind === "threw" ? outcome.error : null;
  if (!isCron) return { result, error: ingestError };
  try {
    await evaluateConversionAlerts(db, outcome);
    if (result?.ok) {
      await recordHeartbeat(db, HEARTBEAT_JOBS.conversionEventsIngest.job_name);
    }
  } catch (err) {
    console.error("[keitaro/poll] conversion ledger monitor failed", err);
    const monitorError = `monitor: ${err instanceof Error ? err.message : String(err)}`;
    return { result, error: ingestError ? `${ingestError}; ${monitorError}` : monitorError };
  }
  return { result, error: ingestError };
}

// EPC's denominator must advance on the SAME tick as its numerator. Revenue
// lands here every 5 minutes; if counted clickers refreshed independently, EPC
// would drift between rebuilds and snap back at each one — an artifact that
// reads exactly like a real trend on the platform's primary metric. So the
// incremental pass rides this poll. It is additive and stateless (6h lookback,
// no cursor), so a failure here can never strand data; the daily full rebuild
// is the repair path. Never let a poll failure mask a refresh failure or vice
// versa — they are reported separately.
async function pollAndRefresh(windowDays: number | undefined, isCron: boolean) {
  const poll = await pollKeitaro(db, { windowDays });
  let clickers: unknown = null;
  let clickersError: string | null = null;
  try {
    clickers = await refreshCountedClickers(db, "incremental");
  } catch (err) {
    clickersError = err instanceof Error ? err.message : String(err);
    console.error("[keitaro/poll] counted-clicker refresh failed", err);
  }
  const ledger = await ingestConversionLedger(isCron);
  // THE STAGE-DAY PROJECTION, and ONLY after a complete ingest window.
  // syncStageDayConversions re-derives its scope from the ledger and zeroes the
  // days the ledger no longer explains, so running it against a ledger that is
  // missing rows would zero real revenue. A refused or thrown ingest therefore
  // skips it entirely and the stage-days keep their previous values until the
  // next good tick.
  //
  // Scope = the stages this tick's CLICK window touched, plus every stage whose
  // LEDGER ROWS changed in the last LEDGER_CHANGE_LOOKBACK_MINUTES. The second
  // half is what repairs a re-posted OLD conversion: occurred_at doesn't move, so
  // its stage-day is outside the click window and only `updated_at` finds it.
  let stageDays: StageDayConversionSync | null = null;
  let stageDaysError: string | null = null;
  if (ledger.result?.ok) {
    try {
      const changed = await changedLedgerStageIds(db);
      const scope = [...new Set([...poll.stage_ids, ...changed])];
      stageDays = await syncStageDayConversions(db, { stageIds: scope });
    } catch (err) {
      stageDaysError = err instanceof Error ? err.message : String(err);
      console.error("[keitaro/poll] stage-day conversion sync failed", err);
    }
  }
  return {
    ...poll,
    counted_clickers: clickers,
    counted_clickers_error: clickersError,
    conversion_events: ledger.result,
    conversion_events_error: ledger.error,
    stage_day_conversions: stageDays,
    stage_day_conversions_error: stageDaysError,
  };
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches =
    !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  if (!bearerMatches) {
    const auth = await requireApiMembership();
    if ("error" in auth) return auth.error;
    // Triggering a results sync is an import-shaped action (operator+).
    if (!can(auth.role, "result_imports.create")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const windowRaw = Number(req.nextUrl.searchParams.get("windowDays"));
  const windowDays =
    Number.isFinite(windowRaw) && windowRaw > 0
      ? Math.min(30, Math.floor(windowRaw))
      : undefined;

  // Scheduled (cron) runs are single-runner: a prior tick whose SQL is still
  // draining server-side after a timeout-kill must not get piled on. Manual
  // operator runs bypass the lease (they must not silently no-op).
  if (bearerMatches) {
    const leased = await withCronLease("keitaro-poll", () =>
      pollAndRefresh(windowDays, true),
    );
    if (!leased.ran) {
      return NextResponse.json({
        skipped: true,
        reason: "prior_run_in_progress",
        skippedCount: leased.skippedCount,
      });
    }
    return NextResponse.json(leased.result);
  }

  const result = await pollAndRefresh(windowDays, false);

  // A degraded run (fetch failed) returns 200 with degraded:true so the cron
  // doesn't flap red on a transient Keitaro hiccup — it logs and retries next
  // cycle. The body surfaces everything needed to debug (incl. unmatched
  // sub_id_3 samples when nothing maps back to a CamMan stage).
  return NextResponse.json(result);
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
