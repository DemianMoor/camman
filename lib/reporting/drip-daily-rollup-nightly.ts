import { sql } from "drizzle-orm";

import {
  classifyCohortClickDiffs,
  DRIP_DAILY_ROLLUP_RECONCILE_JOB,
  DRIP_DAILY_ROLLUP_SETTLE_JOB,
  nightlyUnits,
  nightWindow,
  parseStamp,
  unitDone,
  unitEligible,
  type CellDiff,
  type ClickRepair,
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
//
// Cohort-click repair (owner ruling 2026-11-12, option B): a reconcile diff that
// is ONLY late clicks on a cohort cell (fresh clicks > stored, every other
// counter equal) is written back and logged in drip_daily_rollup_repairs (0238)
// instead of alerting. Everything else — another counter, the activity basis, a
// missing/extra cell, stored clicks ABOVE fresh — is drift and alerts as before.
// A night whose repairs would exceed MAX_NIGHTLY_REPAIR_CELLS / _CLICKS stops
// repairing and alerts (REPAIR_GUARD_ALERT) for the rest of that night.

export const DRIFT_ALERT = "drip-daily-rollup-drift";
export const NIGHTLY_INCOMPLETE_ALERT = "drip-daily-rollup-nightly-incomplete";
/** Stamped when any reconcile unit finds drift; the drift alert clears only on a clean night. */
export const DRIFT_SEEN_JOB = `${DRIP_DAILY_ROLLUP_RECONCILE_JOB}:drift-seen`;
/**
 * No unit STARTS after this much of the run has elapsed. maxDuration is 300 s and
 * the slowest unit measured on prod (11-12, a cohort settle) took 146 s: 90 + 146
 * leaves ~60 s for tier A and the rest. It was 120 s until 2026-11-12, when the
 * 05:31 run reached ~256 s of 300 (owner: cap at 90 s).
 */
export const NIGHTLY_RUN_BUDGET_MS = 90_000;
/** A unit slower than this logs an over-budget line (its share of a run is the budget above). */
export const UNIT_WARN_MS = 90_000;
export const REPAIR_GUARD_ALERT = "drip-daily-rollup-repair-guard";
/** Stamped when tonight's repair guard trips: no more repairs that night; the alert clears only on a night it did not trip. */
export const REPAIR_GUARD_JOB = `${DRIP_DAILY_ROLLUP_RECONCILE_JOB}:repair-guard`;
/**
 * Per org, per night. Measured on prod: one night of late cohort clicks on days
 * 14–20 back was 1–19 cells / 4–36 clicks (nights 10-20 … 11-12); 11-12's
 * reconcile — a week of them piled up, the size of the first night after this
 * ships — was 22 cells / +39. Beyond ~3× the worst cells or ~4× the worst clicks
 * is not ordinary late clicks, so it alerts instead of repairing.
 */
export const MAX_NIGHTLY_REPAIR_CELLS = 60;
export const MAX_NIGHTLY_REPAIR_CLICKS = 150;

export interface NightlyDeps {
  db: DbOrTx;
  orgIds: string[];
  now: () => Date;
  /** Wall-clock ms the run started, for the budget. */
  runStartedMs: number;
  /** Recompute one unit's cells for one org. */
  settle: (orgId: string, unit: NightlyUnit) => Promise<void>;
  /** Compare one unit's frozen cells for one org; returns every differing cell. */
  reconcile: (orgId: string, unit: NightlyUnit) => Promise<CellDiff[]>;
  /** Write cohort-click repairs + their trail rows; returns the number written (throws if any cell moved). */
  repair: (orgId: string, unitKey: string, repairs: ClickRepair[]) => Promise<number>;
  /** Repairs already recorded for this org since `since` (tonight's window start). */
  repairTotals: (orgId: string, since: Date) => Promise<{ cells: number; clicks: number }>;
  notify: (alertKey: string, text: string) => Promise<void>;
  clear: (alertKey: string) => Promise<void>;
}

export interface NightlyResult {
  in_window: boolean;
  ran: string[];
  failed: { key: string; error: string }[];
  over_budget: string[];
  stopped_for_budget: boolean;
  /** Differing cells NOT repaired, which alert as drift (includes `negative`). */
  drift: number;
  /** Of `drift`: only clicks differed, but stored was HIGHER than fresh. */
  negative: number;
  /** Cohort-click cells repaired in this run, and the clicks they added. */
  repaired_cells: number;
  repaired_clicks: number;
  /** Repairable cells NOT written because tonight's guard tripped. */
  repairs_withheld: number;
  repair_guard_tripped: boolean;
  /** Cells repaired tonight across every run so far (all orgs), from the trail table. */
  night_repaired_cells: number;
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
  const extra = [DRIP_DAILY_ROLLUP_SETTLE_JOB, DRIP_DAILY_ROLLUP_RECONCILE_JOB, DRIFT_SEEN_JOB, REPAIR_GUARD_JOB];
  let states = await readStates(dbc, [...units.map((u) => u.key), ...extra]);

  const res: NightlyResult = {
    in_window: inWindow, ran: [], failed: [], over_budget: [], stopped_for_budget: false,
    drift: 0, negative: 0, repaired_cells: 0, repaired_clicks: 0, repairs_withheld: 0,
    repair_guard_tripped: unitDone(now, states.get(REPAIR_GUARD_JOB)), night_repaired_cells: 0,
    settle_done: false, reconcile_done: false, pending: [],
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
          const { repairs, negative, drift } = classifyCohortClickDiffs(await deps.reconcile(orgId, u));
          const d = drift.length + negative.length;
          if (d > 0) {
            res.drift += d;
            res.negative += negative.length;
            console.error("[drip-daily-rollup] DRIFT in frozen cells", {
              org_id: orgId, unit: u.key, range: u.range, diffs: d, negative: negative.length,
              cells: [...drift, ...negative].slice(0, 20).map((c) => c.key),
            });
            await stamp(dbc, DRIFT_SEEN_JOB, "watermark", deps.now());
            await deps.notify(
              DRIFT_ALERT,
              `⚠️ Drip Daily results rollup: ${d} FROZEN cell(s) in ${u.range.from}..${u.range.to} (${u.basis}) ` +
                `no longer match a fresh computation` +
                (negative.length > 0 ? ` (${negative.length} with stored clicks ABOVE fresh)` : "") +
                `. Something changed a cell's source more than 14 days after the fact, beyond the ` +
                `late cohort clicks that are repaired automatically. Not repaired. ` +
                `Vercel logs: [drip-daily-rollup] DRIFT.`,
            );
          }
          if (repairs.length > 0) {
            const clicks = repairs.reduce((a, r) => a + (r.new_clicks - r.old_clicks), 0);
            const before = res.repair_guard_tripped ? null : await deps.repairTotals(orgId, start);
            const overCap =
              before !== null &&
              (before.cells + repairs.length > MAX_NIGHTLY_REPAIR_CELLS ||
                before.clicks + clicks > MAX_NIGHTLY_REPAIR_CLICKS);
            if (before === null || overCap) {
              res.repairs_withheld += repairs.length;
              console.error("[drip-daily-rollup] repair guard: repairs withheld", {
                org_id: orgId, unit: u.key, range: u.range, cells: repairs.length, clicks,
                tonight_before: before, max_cells: MAX_NIGHTLY_REPAIR_CELLS, max_clicks: MAX_NIGHTLY_REPAIR_CLICKS,
              });
              if (before !== null) {
                res.repair_guard_tripped = true;
                await stamp(dbc, REPAIR_GUARD_JOB, "watermark", deps.now());
                await deps.notify(
                  REPAIR_GUARD_ALERT,
                  `⚠️ Drip Daily results rollup: tonight's late-click repairs would reach ` +
                    `${before.cells + repairs.length} cohort cell(s) / +${before.clicks + clicks} clicks ` +
                    `(cap ${MAX_NIGHTLY_REPAIR_CELLS} / ${MAX_NIGHTLY_REPAIR_CLICKS}; a normal night is under 20 / 40). ` +
                    `That is not ordinary late clicks, so repairs stopped for the rest of the night and those ` +
                    `cells were left as they were. Vercel logs: [drip-daily-rollup] repair guard.`,
                );
              }
            } else {
              const n = await deps.repair(orgId, u.key, repairs);
              res.repaired_cells += n;
              res.repaired_clicks += clicks;
              console.info("[drip-daily-rollup] repaired late cohort clicks", {
                org_id: orgId, unit: u.key, range: u.range, cells: n, clicks,
                repairs: repairs.map(
                  (r) => `${r.campaign_id}/${r.day_et}/${r.stage_id ?? "lead"}/${r.partner_key_id ?? "unattributed"}: ${r.old_clicks}→${r.new_clicks}`,
                ),
              });
            }
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
    if (!unitDone(t, states.get(REPAIR_GUARD_JOB))) await deps.clear(REPAIR_GUARD_ALERT);
  }
  for (const orgId of deps.orgIds) res.night_repaired_cells += (await deps.repairTotals(orgId, start)).cells;

  // Window closed with work left: tell the owner the same morning.
  if (t >= end && !(res.settle_done && res.reconcile_done)) {
    console.error("[drip-daily-rollup] nightly pass did not finish", { pending: res.pending });
    await deps.notify(
      NIGHTLY_INCOMPLETE_ALERT,
      `⚠️ Drip Daily results rollup: the nightly pass did not finish by 09:00 UTC. ` +
        `Pending (${res.pending.length}): ${res.pending.slice(0, 6).join("; ")}${res.pending.length > 6 ? "; …" : ""}. ` +
        `It will not retry until 05:00 UTC tomorrow; today and yesterday still refresh every 15 min. ` +
        `Vercel logs: [drip-daily-rollup] nightly unit.`,
    );
  }
  return res;
}
