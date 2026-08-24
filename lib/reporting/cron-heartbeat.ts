import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// =============================================================================
// DEAD-MAN CHECK for the scheduled reporting jobs.
//
// Alerting only on breach is right — a weekly all-clear trains people to ignore
// the channel. But it makes SILENCE AMBIGUOUS: no message means either "healthy"
// or "the job stopped running two months ago and nothing has been checked
// since". That second reading is the one you discover in November.
//
// So each job records a heartbeat, and each job checks SOMEBODY ELSE'S. The
// check must never live inside the job it watches: a job that is dead cannot
// report itself dead. The pairing is mutual —
//
//   the weekly monitors job    watches the daily rebuild   (notices within a week)
//   the daily rebuild job      watches the weekly monitors (notices within a day)
//
// Either one dying is therefore caught by the other, and both dying at once is
// caught by the absence of the Telegram traffic the rest of the platform emits.
// =============================================================================

export interface HeartbeatExpectation {
  job_name: string;
  // Maximum tolerable silence. Set to roughly 2x the schedule interval so a
  // single missed run (a deploy, a transient failure) does not page anyone, but
  // two in a row does.
  max_age_hours: number;
  label: string;
}

export const HEARTBEAT_JOBS: Record<string, HeartbeatExpectation> = {
  // The drip scheduler (Phase 5). Watched by drip-monitors.
  dripScheduler: {
    job_name: "drip-scheduler",
    max_age_hours: 1,
    label: "drip scheduler (1-min)",
  },
  // The drip monitors job itself — watched BY the scheduler, closing the
  // P3 gap where the watcher had no watcher.
  dripMonitors: {
    job_name: "drip-monitors",
    max_age_hours: 2,
    label: "drip monitors (15-min)",
  },
  // The drip routing worker (Phase 4). Watched by /api/cron/drip-monitors,
  // never by itself. Runs every minute; 1 hour is ~60 missed runs.
  dripRouting: {
    job_name: "drip-routing",
    max_age_hours: 1,
    label: "drip routing worker (1-min)",
  },
  // The drip lead-enrichment sweeper (Phase 3). Watched by /api/cron/drip-monitors,
  // never by itself — a job that checks its own liveness is silent in exactly the
  // case that matters. Runs every minute, so 1 hour is ~60 missed runs: generous
  // enough that a deploy or a transient failure does not page anyone, and far
  // short of a working day.
  leadEnrichment: {
    job_name: "lead-enrichment",
    max_age_hours: 1,
    label: "drip lead enrichment sweeper (1-min)",
  },
  epcMonitors: {
    job_name: "epc-monitors",
    max_age_hours: 24 * 16, // weekly cadence, ~2 missed runs
    label: "EPC integrity monitors (weekly)",
  },
  // The hourly Keitaro tracking-gap monitor. Watched by tells-monitors — see
  // app/api/cron/tells-monitors/route.ts, which is also hourly and calls
  // checkHeartbeats(db, [HEARTBEAT_JOBS.tellsSweep, HEARTBEAT_JOBS.trackingMonitors]).
  // Not a mutual pair like the Tells watch below: nothing watches
  // tells-monitors' own liveness back on this job's behalf, so this only
  // closes the "tracking-monitors alone stops running" gap.
  trackingMonitors: {
    job_name: "tracking-monitors",
    max_age_hours: 3, // hourly cadence, ~2 missed runs
    label: "Keitaro tracking-gap monitor (hourly)",
  },
  // The weekly clickers rebuild — the repair path for the watermark-stranding
  // failure. It gets the same heartbeat treatment as everything else: if it
  // stops running, that must surface rather than being read as healthy.
  clickerRebuild: {
    job_name: "propagate-clickers-rebuild",
    max_age_hours: 24 * 16, // weekly cadence, ~2 missed runs
    label: "clickers propagate rebuild (weekly)",
  },
  // The offer-report matview refresh. Its route ALREADY handles failure well —
  // try/catch, a Tier-1 alert, a 500 so the scheduler flags red, and it stamps
  // report_refresh_log only after both refreshes succeed, so a failure leaves a
  // stale timestamp rather than a falsely fresh one. What none of that covers is
  // the job never being invoked: the catch block only runs if the route runs. A
  // no-show leaves the last good numbers on screen, plausible and months old.
  offerReportRefresh: {
    job_name: "offer-group-report-refresh",
    max_age_hours: 26, // twice-daily (05:00/20:00 UTC); worst normal age is 15h
    label: "offer-report matview refresh (twice daily)",
  },
  countedClickersFull: {
    job_name: "counted-clickers-rebuild",
    max_age_hours: 52, // daily cadence, ~2 missed runs
    label: "counted-clicker full rebuild (daily)",
  },
  // ---- Tells (spec §4.5) — MUTUAL WATCH, because these two are the sole
  // detection layer for broken STOP intake and a dead job cannot report itself
  // dead. tellsMonitors (hourly) checks tellsSweep; tellsSweep (*/5) checks
  // tellsMonitors. Neither vouches for itself.
  tellsMonitors: {
    job_name: "tells-monitors",
    max_age_hours: 3, // hourly cadence, ~2 missed runs
    label: "Tells silence monitors (hourly)",
  },
  tellsSweep: {
    job_name: "tells-sweep",
    max_age_hours: 1, // every 5 min; 1h is ~11 missed runs
    label: "Tells webhook sweeper (every 5 min)",
  },
};

// Stamp a heartbeat for this job. Reuses cron_locks, which is already keyed by
// job_name; `watermark` carries the last successful completion.
export async function recordHeartbeat(
  dbc: DbOrTx,
  jobName: string,
): Promise<void> {
  await dbc.execute(sql`
    INSERT INTO cron_locks (job_name, watermark) VALUES (${jobName}, now())
    ON CONFLICT (job_name) DO UPDATE SET watermark = now()
  `);
}

export interface HeartbeatStatus {
  job_name: string;
  label: string;
  last_run: string | null;
  age_hours: number | null;
  max_age_hours: number;
  stale: boolean;
}

// Check the heartbeats of jobs OTHER than the caller. A NULL watermark counts as
// stale: a job that has never recorded a run is indistinguishable from one that
// stopped, and both need looking at.
export async function checkHeartbeats(
  dbc: DbOrTx,
  expectations: HeartbeatExpectation[],
): Promise<HeartbeatStatus[]> {
  if (expectations.length === 0) return [];
  const names = sql.join(
    expectations.map((e) => sql`${e.job_name}`),
    sql`, `,
  );
  const rows = (await dbc.execute(sql`
    SELECT job_name, watermark::text AS last_run,
           EXTRACT(EPOCH FROM (now() - watermark)) / 3600 AS age_hours
    FROM cron_locks WHERE job_name IN (${names})
  `)) as unknown as { job_name: string; last_run: string | null; age_hours: number | null }[];

  return expectations.map((e) => {
    const row = rows.find((r) => r.job_name === e.job_name);
    const age = row?.age_hours == null ? null : Number(row.age_hours);
    return {
      job_name: e.job_name,
      label: e.label,
      last_run: row?.last_run ?? null,
      age_hours: age == null ? null : Number(age.toFixed(1)),
      max_age_hours: e.max_age_hours,
      stale: age == null || age > e.max_age_hours,
    };
  });
}

export function heartbeatBreaches(statuses: HeartbeatStatus[]): string[] {
  return statuses
    .filter((s) => s.stale)
    .map((s) =>
      s.last_run == null
        ? `${s.label} has NEVER recorded a run. Silence from it means nothing.`
        : `${s.label} last ran ${s.age_hours}h ago (tolerance ${s.max_age_hours}h). ` +
          `Its silence cannot be read as healthy.`,
    );
}
