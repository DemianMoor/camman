import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { can } from "@/lib/permissions";
import {
  HEARTBEAT_JOBS,
  checkHeartbeats,
  heartbeatBreaches,
  recordHeartbeat,
} from "@/lib/reporting/cron-heartbeat";
import { runTellsMonitors } from "@/lib/sends/tells-monitors";

// Tells silence monitors (Phase 4) — spec §4.5.
//
// ⚠️ COMPLIANCE INFRASTRUCTURE, NOT OBSERVABILITY POLISH. With STOP-undelivered
// self-healing closed as won't-build and Tells offering no reconciliation API,
// a broken inbound webhook produces NO other symptom — sends succeed, DLRs
// arrive, dashboards look healthy, and STOPs pile up unsuppressed until a
// carrier complaint. These monitors are the only thing that can notice.
//
//   1. inbound silence   — zero inbound events across N thousand sends
//   2. DLR coverage      — matured sends without a terminal receipt
//   3. sweeper backlog   — rows unprocessed past one sweeper interval
//   4. undelivered tripwire — runbook §2b, >8% undelivered on a matured batch.
//      Computed through lib/reporting/delivery.ts, the SAME layer that backs
//      /reports/delivery, so the alert and the page cannot disagree. DETECTS
//      ONLY — the MPS response stays manual.
//   + duplicates          — DIAGNOSTIC ONLY, never alerts (§4.2)
//   + dead-man on the sweeper (a dead job cannot report itself dead)
//
// Breach-only: a periodic all-clear trains people to ignore the channel.
// Auth mirrors /api/reports/epc-monitors.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearerMatches = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;

  if (!bearerMatches) {
    const auth = await requireApiMembership();
    if ("error" in auth) return auth.error;
    if (!can(auth.role, "campaigns.view")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const report = await runTellsMonitors(db);

  // Dead-man: this job watches the SWEEPER, never itself. The sweeper returns
  // the favour by watching this job (see lib/sends/tells-sweep.ts) — so if
  // either stops running, the other says so.
  //
  // Also watches the Keitaro tracking-gap monitor (hourly, no other watcher —
  // see HEARTBEAT_JOBS.trackingMonitors in lib/reporting/cron-heartbeat.ts).
  // Piggybacking here rather than adding a new hourly route: this job already
  // runs on that cadence.
  const heartbeats = await checkHeartbeats(db, [
    HEARTBEAT_JOBS.tellsSweep,
    HEARTBEAT_JOBS.trackingMonitors,
  ]);
  const allBreaches = [...report.breaches, ...heartbeatBreaches(heartbeats)];

  if (bearerMatches && allBreaches.length > 0) {
    const c = report.dlr_coverage;
    const lines = [
      "🚨 <b>Tells monitors</b> — STOP intake is the compliance-critical path",
      "",
      ...allBreaches.map((b) => `• ${b}`),
      "",
      `Sends (${report.inbound_silence.window_hours}h): ${report.inbound_silence.tells_sends} · ` +
        `inbound events: ${report.inbound_silence.inbound_events}`,
      `DLR coverage: ${c.sends_with_terminal_dlr}/${c.matured_sends}` +
        (c.coverage_ratio === null ? "" : ` (${(c.coverage_ratio * 100).toFixed(1)}%)`),
      // The counting rule, shown so the maths is checkable from the alert itself.
      `DLR events: ${c.actual_events} actual vs ${c.expected_events} expected ` +
        `(2×${c.delivered_messages} delivered + 1×${c.undelivered_messages} undelivered)`,
      // Runbook §2b. Shown on EVERY breach (not only a tripwire breach) so the
      // undelivered rate is always visible next to a delivery-related alert —
      // carrier filtering surfaces here and nowhere else.
      `Undelivered tripwire: ${report.undelivered_tripwire.breached_batches.length} of ` +
        `${report.undelivered_tripwire.batches_evaluated} matured batch(es) over ` +
        `${(report.undelivered_tripwire.threshold_ratio * 100).toFixed(0)}%` +
        (report.undelivered_tripwire.breached_batches.length > 0
          ? ` — worst ${(report.undelivered_tripwire.breached_batches[0].undelivered_ratio * 100).toFixed(1)}%`
          : ""),
      `Unprocessed >${report.unprocessed_backlog.stale_minutes}min: ${report.unprocessed_backlog.stale_rows}`,
      // Diagnostic, deliberately reported but never a breach.
      `Duplicates (${report.duplicates.window_hours}h): ${report.duplicates.total_duplicate_count} ` +
        `across ${report.duplicates.rows_with_duplicates} row(s) — diagnostic only`,
    ];
    try {
      await notifyTelegram(lines.join("\n"));
    } catch (err) {
      // Never let alert delivery failure fail the job — the response body still
      // carries the findings and the next run re-evaluates from scratch.
      console.error("[tells-monitors] telegram delivery failed", err);
    }
  }

  // Stamp AFTER the work, so a run that threw does not look healthy.
  if (bearerMatches) await recordHeartbeat(db, HEARTBEAT_JOBS.tellsMonitors.job_name);

  return NextResponse.json({ ...report, heartbeats, breaches: allBreaches });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
