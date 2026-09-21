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
//  3. 2026-09-21, the same read-only `EXPLAIN (ANALYZE, BUFFERS)` on PROD but
//     UNSTUBBED — 0181 has applied, so conversion_events is real (1,517 rows,
//     backfilled). Three runs: offer-totals 35.7/36.5/35.6s · group
//     112.1/111.2/114.8s · audience-totals 1.2/1.1/1.1s (measured separately,
//     pending_revenue stubbed to 0 because the INSTALLED group matview predates
//     0183) ⇒ per-run totals 147.8 / 147.7 / 150.4s. This supersedes (2).
//  4. 2026-09-21, the REAL last cron run, read back as the deltas between
//     consecutive report_refresh_log stamps (each is written immediately after
//     its own view's refresh, in a fixed order): group 107.5s · offer-totals
//     36.7s · audience-totals 0.95s, at 05:01-05:03 UTC, PRE-0183 definitions.
//     org_summary has no predecessor stamp so its duration is not recoverable
//     this way.
//
// ⭐ CORRECTION, MEASURED: this comment used to assert "the real refresh costs
// MORE" than the SELECT. For THIS family it does not. The INSTALLED (pre-0183)
// group definition's own SELECT, read back via pg_get_viewdef on 2026-09-21,
// costs 109.6/111.8/113.2s (avg 111.5) under EXPLAIN ANALYZE — while (4) says
// the real CONCURRENTLY refresh of that identical definition took 107.5s. So
// EXPLAIN ANALYZE's per-node timing overhead EXCEEDS what CONCURRENTLY adds.
// That holds because these matviews are tiny (56-96 kB): the transient copy,
// the unique-index build and the FULL OUTER JOIN diff are noise next to a ~112s
// scan. Treat an EXPLAIN ANALYZE of a defining SELECT here as a slight
// OVER-estimate of its refresh, not an under-estimate.
//
// ⭐ AND 0183 IS NOT WHAT COSTS: new definition 112.7s avg vs installed 111.5s
// avg — ~+1.2s, inside run-to-run variance. The ledger CTE aggregates ~1.5K
// indexed rows. What dominates is one sort spilling to disk: `external merge
// Sort Space Used: 170160 kB` at the cluster's work_mem = 5120 kB, every other
// sort in the plan being an in-memory quicksort of <= 5 MB. work_mem remains
// the first knob, and it is now the knob that matters most.
//
// ⛔ maxDuration = 300 IS NOT THE BINDING LIMIT. Prod's statement_timeout is
// 120000 ms — source `configuration file`,
// /etc/postgresql-custom/platform-defaults.conf:6, reset_val 120000: a Supabase
// cluster default on EVERY connection, including this route's.
// pg_db_role_setting carries no statement_timeout for the `postgres` role (only
// anon 3s, authenticated/authenticator 8s), and refreshOfferGroupReport() never
// raises one — unlike lib/reporting/counted-clickers.ts (300s) and
// lib/reporting/epc-monitors.ts (240s), which do. Any single REFRESH past 120s
// is cancelled with SQLSTATE 57014 long before 300s is reached, and (4) puts
// the group refresh at 107.5s TODAY: 12.5s of headroom, pre-0183, which 0183
// spends about 1s of. One of four measurements of the new SELECT came in at
// 120.1s. This is a pre-existing ceiling, not one this migration introduces.
// Failure is NOT silent at the DB wall (57014 ⇒ throw ⇒ the catch below fires a
// Tier-1 Telegram alert and returns 500) but IS silent at the Vercel wall (a
// maxDuration kill never reaches the catch). Because the four refreshes run in
// sequence and group is #2, a group failure means offer-totals and
// audience-totals are skipped ENTIRELY, every run, until it is fixed.
// Remedy when it trips: give this job a session-mode connection and set
// statement_timeout + work_mem on it. Splitting into per-matview cron
// invocations does NOT help — it divides the Vercel budget, which is not the
// constraint, and cannot make one REFRESH statement shorter.
// See docs/04-features/offer-group-report.md.
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
