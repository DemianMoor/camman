import { sql } from "drizzle-orm";

import {
  DRIP_DAILY_ROLLUP_RECONCILE_JOB,
  DRIP_DAILY_ROLLUP_SETTLE_JOB,
  nightlyUnits,
  nightWindow,
  parseStamp,
  unitDone,
  unitEligible,
  type DbOrTx,
  type NightlyUnit,
  type UnitState,
} from "@/lib/reporting/drip-daily-rollup";

// The nightly half of /api/cron/drip-daily-rollup: settle (days 2–13 back) and
// reconcile (frozen days 14–20 back), as small UNITS spread across runs.
//
// Why units (2026-11-11): the settle + reconcile used to be one pass stamped
// only when the whole pass succeeded. When drip volume grew it no longer fit one
// run — every attempt was cut off in the reconcile, nothing was stamped, and
// every 15-min tick of the working day re-ran the full 14-day recompute
// (~1,200 s of disk-bound DB time per hour), slowing audience previews and stage
// creation for everyone. Now:
//   - progress is per unit (cron_locks: last_run_started_at = attempt,
//     watermark = done), so a run that is cut off loses only its current unit;
//   - each phase is stamped the moment its last unit finishes, independently;
//   - units only start inside [05:00, 09:00) UTC, and a failed unit waits
//     NIGHTLY_RETRY_SPACING_MS — the retry cap;
//   - a run stops starting units once its budget is spent, so the pass keeps
//     fitting as data grows (more runs, not longer ones);
//   - an unfinished pass at 09:00 UTC is a Telegram alert, re-armed each night.

export const DRIFT_ALERT = "drip-daily-rollup-drift";
export const NIGHTLY_INCOMPLETE_ALERT = "drip-daily-rollup-nightly-incomplete";
/** Stamped when any reconcile unit finds drift; the drift alert clears only on a clean night. */
export const DRIFT_SEEN_JOB = `${DRIP_DAILY_ROLLUP_RECONCILE_JOB}:drift-seen`;
/** No unit STARTS after this much of the run has elapsed (maxDuration 300 s; a unit is ~20–60 s). */
export const NIGHTLY_RUN_BUDGET_MS = 120_000;
/** A unit slower than this logs an over-budget line (its share of a run is the budget above). */
export const UNIT_WARN_MS = 90_000;

export interface NightlyDeps {
  db: DbOrTx;
  orgIds: string[];
  now: () => Date;
  /** Wall-clock ms the run started, for the budget. */
  runStartedMs: number;
  /** Recompute one unit's cells for one org. */
  settle: (orgId: string, unit: NightlyUnit) => Promise<void>;
  /** Compare one unit's frozen cells for one org; returns the number of differing cells. */
  reconcile: (orgId: string, unit: NightlyUnit) => Promise<number>;
  notify: (alertKey: string, text: string) => Promise<void>;
  clear: (alertKey: string) => Promise<void>;
}

export interface NightlyResult {
  in_window: boolean;
  ran: string[];
  failed: { key: string; error: string }[];
  over_budget: string[];
  stopped_for_budget: boolean;
  drift: number;
  settle_done: boolean;
  reconcile_done: boolean;
  pending: string[];
}

// Stamped with the SAME clock the eligibility decisions read (deps.now), so the
// "done tonight" test never compares two clocks.
async function stamp(dbc: DbOrTx, job: string, col: "watermark" | "last_run_started_at", at: Date): Promise<void> {
  await dbc.execute(sql`
    INSERT INTO cron_locks (job_name, ${sql.raw(col)}) VALUES (${job}, ${at.toISOString()}::timestamptz)
    ON CONFLICT (job_name) DO UPDATE SET ${sql.raw(col)} = EXCLUDED.${sql.raw(col)}`);
}

async function readStates(dbc: DbOrTx, keys: string[]): Promise<Map<string, UnitState>> {
  const rows = (await dbc.execute(sql`
    SELECT job_name, watermark, last_run_started_at FROM cron_locks
    WHERE job_name IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})`)) as unknown as {
    job_name: string;
    watermark: string | null;
    last_run_started_at: string | null;
  }[];
  return new Map(
    rows.map((r) => [r.job_name, { done: parseStamp(r.watermark), attempted: parseStamp(r.last_run_started_at) }]),
  );
}

const describe = (u: NightlyUnit) => `${u.phase} ${u.basis} ${u.range.from}..${u.range.to}`;

export async function runNightly(deps: NightlyDeps): Promise<NightlyResult> {
  const { db: dbc } = deps;
  const now = deps.now();
  const { start, end } = nightWindow(now);
  const inWindow = now >= start && now < end;
  const units = nightlyUnits(now);
  const extra = [DRIP_DAILY_ROLLUP_SETTLE_JOB, DRIP_DAILY_ROLLUP_RECONCILE_JOB, DRIFT_SEEN_JOB];
  let states = await readStates(dbc, [...units.map((u) => u.key), ...extra]);

  const res: NightlyResult = {
    in_window: inWindow, ran: [], failed: [], over_budget: [], stopped_for_budget: false,
    drift: 0, settle_done: false, reconcile_done: false, pending: [],
  };

  // Re-arm the "did not finish" alert for tonight, so a failure tomorrow morning
  // is a new message rather than a latch still held from today.
  if (inWindow) await deps.clear(NIGHTLY_INCOMPLETE_ALERT);

  for (const u of units) {
    if (!unitEligible(deps.now(), states.get(u.key))) continue;
    if (Date.now() - deps.runStartedMs >= NIGHTLY_RUN_BUDGET_MS) {
      res.stopped_for_budget = true;
      break;
    }
    await stamp(dbc, u.key, "last_run_started_at", deps.now());
    const t0 = Date.now();
    try {
      for (const orgId of deps.orgIds) {
        if (u.phase === "settle") {
          await deps.settle(orgId, u);
        } else {
          const d = await deps.reconcile(orgId, u);
          if (d > 0) {
            res.drift += d;
            console.error("[drip-daily-rollup] DRIFT in frozen cells", { org_id: orgId, unit: u.key, range: u.range, diffs: d });
            await stamp(dbc, DRIFT_SEEN_JOB, "watermark", deps.now());
            await deps.notify(
              DRIFT_ALERT,
              `⚠️ Drip Daily results rollup: ${d} FROZEN cell(s) in ${u.range.from}..${u.range.to} (${u.basis}) ` +
                `no longer match a fresh computation. Something changed a cell's source more than ` +
                `14 days after the fact — the 14-day settle window is too short for it. ` +
                `Vercel logs: [drip-daily-rollup] DRIFT.`,
            );
          }
        }
      }
      await stamp(dbc, u.key, "watermark", deps.now());
      res.ran.push(u.key);
      const ms = Date.now() - t0;
      if (ms > UNIT_WARN_MS) {
        res.over_budget.push(u.key);
        console.warn("[drip-daily-rollup] nightly unit over budget", { unit: u.key, what: describe(u), ms, budget_ms: UNIT_WARN_MS });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error("[drip-daily-rollup] nightly unit failed", { unit: u.key, what: describe(u), ms: Date.now() - t0, error });
      res.failed.push({ key: u.key, error });
      break; // the next tick moves on to other units; this one waits out the retry spacing
    }
  }

  // Phase completion — each stamped independently, the moment its last unit is done.
  states = await readStates(dbc, [...units.map((u) => u.key), ...extra]);
  const t = deps.now();
  const phaseDone = (p: NightlyUnit["phase"]) => units.filter((u) => u.phase === p).every((u) => unitDone(t, states.get(u.key)));
  res.settle_done = phaseDone("settle");
  res.reconcile_done = phaseDone("reconcile");
  res.pending = units.filter((u) => !unitDone(t, states.get(u.key))).map(describe);
  if (res.settle_done && !unitDone(t, states.get(DRIP_DAILY_ROLLUP_SETTLE_JOB))) {
    await stamp(dbc, DRIP_DAILY_ROLLUP_SETTLE_JOB, "watermark", deps.now());
  }
  if (res.reconcile_done && !unitDone(t, states.get(DRIP_DAILY_ROLLUP_RECONCILE_JOB))) {
    await stamp(dbc, DRIP_DAILY_ROLLUP_RECONCILE_JOB, "watermark", deps.now());
    if (!unitDone(t, states.get(DRIFT_SEEN_JOB))) await deps.clear(DRIFT_ALERT);
  }

  // Window closed with work left: tell the owner the same morning.
  if (t >= end && !(res.settle_done && res.reconcile_done)) {
    console.error("[drip-daily-rollup] nightly pass did not finish", { pending: res.pending });
    await deps.notify(
      NIGHTLY_INCOMPLETE_ALERT,
      `⚠️ Drip Daily results rollup: the nightly pass did not finish by 09:00 UTC. ` +
        `Pending (${res.pending.length}): ${res.pending.slice(0, 6).join("; ")}${res.pending.length > 6 ? "; …" : ""}. ` +
        `It will not retry until 05:00 UTC tomorrow; today (every 15 min) and yesterday (hourly) still refresh. ` +
        `Vercel logs: [drip-daily-rollup] nightly unit.`,
    );
  }
  return res;
}
