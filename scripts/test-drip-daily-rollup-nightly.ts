import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  DRIP_DAILY_ROLLUP_RECONCILE_JOB,
  DRIP_DAILY_ROLLUP_SETTLE_JOB,
  type NightlyUnit,
} from "@/lib/reporting/drip-daily-rollup";
import {
  DRIFT_ALERT,
  NIGHTLY_INCOMPLETE_ALERT,
  NIGHTLY_RUN_BUDGET_MS,
  runNightly,
  type NightlyDeps,
} from "@/lib/reporting/drip-daily-rollup-nightly";

// The nightly settle/reconcile orchestration (lib/reporting/drip-daily-rollup-nightly.ts)
// against real cron_locks rows on the PREVIEW DB, in ONE transaction that is
// rolled back (no residue). The cell computation is faked — this tests WHEN
// units run, what gets stamped, and what alerts fire; the cell maths has its
// own bars in test-drip-daily-rollup.ts.
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-daily-rollup-nightly.ts
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
class Rollback extends Error {}
const at = (iso: string) => new Date(iso);

async function main() {
  console.log(`Nightly orchestration (${requirePreviewDb().label}, rolled back):`);
  try {
    await db.transaction(async (tx) => {
      const reset = () =>
        tx.execute(sql`DELETE FROM cron_locks WHERE job_name LIKE ${DRIP_DAILY_ROLLUP_SETTLE_JOB + "%"}
                                              OR job_name LIKE ${DRIP_DAILY_ROLLUP_RECONCILE_JOB + "%"}`);
      const wm = async (job: string) =>
        (((await tx.execute(sql`SELECT watermark FROM cron_locks WHERE job_name = ${job}`)) as unknown as {
          watermark: string | null;
        }[])[0]?.watermark ?? null);

      // A scripted world: which units throw, which find drift, how long each takes.
      let failKeys = new Set<string>();
      let driftKeys = new Map<string, number>();
      let unitSleepMs = 0;
      const attempts = new Map<string, number>();
      let notified: string[] = [];
      let cleared: string[] = [];
      let lastIncompleteText = "";
      const work = async (u: NightlyUnit) => {
        attempts.set(u.key, (attempts.get(u.key) ?? 0) + 1);
        if (unitSleepMs) await new Promise((r) => setTimeout(r, unitSleepMs));
        if (failKeys.has(u.key)) throw new Error(`scripted failure ${u.key}`);
      };
      const run = (nowIso: string, runStartedMs = Date.now()) => {
        notified = [];
        cleared = [];
        const deps: NightlyDeps = {
          db: tx,
          orgIds: ["00000000-0000-0000-0000-000000000000"],
          now: () => at(nowIso),
          runStartedMs,
          settle: async (_o, u) => work(u),
          reconcile: async (_o, u) => {
            await work(u);
            return driftKeys.get(u.key) ?? 0;
          },
          notify: async (k, text) => {
            notified.push(k);
            if (k === NIGHTLY_INCOMPLETE_ALERT) lastIncompleteText = text;
          },
          clear: async (k) => {
            cleared.push(k);
          },
        };
        return runNightly(deps);
      };

      // N1 — before the window nothing heavy runs, even if never run.
      await reset();
      let r = await run("2026-11-12T04:59:00Z");
      bar("N1 04:59 UTC: no unit runs", r.ran.length === 0 && !r.in_window, JSON.stringify(r.ran));

      // N2 — a clean night: every unit, both phases stamped, alerts cleared.
      r = await run("2026-11-12T05:01:00Z");
      bar("N2a 05:01 clean: all 16 units run in one run", r.ran.length === 16 && r.failed.length === 0, String(r.ran.length));
      bar("N2b settle + reconcile both stamped", r.settle_done && r.reconcile_done &&
        (await wm(DRIP_DAILY_ROLLUP_SETTLE_JOB)) !== null && (await wm(DRIP_DAILY_ROLLUP_RECONCILE_JOB)) !== null);
      bar("N2c incomplete alert re-armed, drift alert cleared on a clean night",
        cleared.includes(NIGHTLY_INCOMPLETE_ALERT) && cleared.includes(DRIFT_ALERT));
      r = await run("2026-11-12T05:16:00Z");
      bar("N2d next tick the same night: nothing re-runs", r.ran.length === 0, JSON.stringify(r.ran));

      // N3 — the budget: a run stops STARTING units once its budget is spent.
      await reset();
      unitSleepMs = 400;
      r = await run("2026-11-12T05:01:00Z", Date.now() - (NIGHTLY_RUN_BUDGET_MS - 1000));
      unitSleepMs = 0;
      const firstRun = r.ran.length;
      bar("N3a budget spent → run stops early", r.stopped_for_budget && r.ran.length >= 1 && r.ran.length <= 4, String(r.ran.length));
      bar("N3b partial settle → settle NOT stamped", !r.settle_done && (await wm(DRIP_DAILY_ROLLUP_SETTLE_JOB)) === null);
      r = await run("2026-11-12T05:16:00Z");
      bar("N3c next tick resumes where it stopped and finishes", r.settle_done && r.reconcile_done &&
        r.ran.length === 16 - firstRun && r.pending.length === 0, `${r.ran.length} more`);

      // N4 — settle stamped independently of reconcile, and vice versa.
      await reset();
      attempts.clear();
      const badSettle = `${DRIP_DAILY_ROLLUP_SETTLE_JOB}:cohort:1`;
      failKeys = new Set([badSettle]);
      r = await run("2026-11-12T05:01:00Z");
      bar("N4a a failing unit stops that run (units before it are kept)",
        r.failed.length === 1 && r.failed[0].key === badSettle && r.ran.length === 3, JSON.stringify(r.ran));
      failKeys = new Set();
      r = await run("2026-11-12T05:16:00Z");
      bar("N4b 15 min later the failed unit waits; the rest run",
        !r.ran.includes(badSettle) && r.ran.length === 12 && attempts.get(badSettle) === 1, String(r.ran.length));
      bar("N4c reconcile stamped although settle is unfinished", r.reconcile_done && !r.settle_done &&
        (await wm(DRIP_DAILY_ROLLUP_RECONCILE_JOB)) !== null && (await wm(DRIP_DAILY_ROLLUP_SETTLE_JOB)) === null);
      r = await run("2026-11-12T06:02:00Z");
      bar("N4d 61 min later it is retried, settle completes and is stamped",
        r.ran.length === 1 && r.ran[0] === badSettle && r.settle_done && (await wm(DRIP_DAILY_ROLLUP_SETTLE_JOB)) !== null);

      // N5 — the retry cap and the same-morning alert.
      await reset();
      attempts.clear();
      failKeys = new Set([badSettle]);
      for (const t of ["05:01", "05:16", "05:31", "05:46", "06:02", "06:17", "07:03", "07:18", "08:04", "08:19", "08:49"]) {
        r = await run(`2026-11-12T${t}:00Z`);
        bar(`N5 ${t}: no incomplete alert inside the window`, !notified.includes(NIGHTLY_INCOMPLETE_ALERT));
      }
      bar("N5a failing unit attempted at most 4 times in the window (60-min spacing)",
        attempts.get(badSettle) === 4, String(attempts.get(badSettle)));
      for (const t of ["09:01", "12:31", "16:46"]) {
        r = await run(`2026-11-12T${t}:00Z`);
        bar(`N5b ${t}: outside the window nothing heavy runs`, r.ran.length === 0 && attempts.get(badSettle) === 4);
      }
      r = await run("2026-11-12T09:16:00Z");
      bar("N5c after 09:00 an unfinished pass alerts, naming what is pending",
        notified.includes(NIGHTLY_INCOMPLETE_ALERT) && /pending \(1\)/i.test(lastIncompleteText) && /settle cohort/.test(lastIncompleteText),
        lastIncompleteText.slice(0, 160));
      failKeys = new Set();
      r = await run("2026-11-13T05:01:00Z");
      bar("N5d next night: alert re-armed, the failed unit (and the rest) run again",
        cleared.includes(NIGHTLY_INCOMPLETE_ALERT) && r.ran.includes(badSettle) && r.settle_done && r.reconcile_done);

      // N6 — drift: alert on find, kept on that night, cleared only by a clean night.
      await reset();
      const driftUnit = `${DRIP_DAILY_ROLLUP_RECONCILE_JOB}:activity:2`;
      driftKeys = new Map([[driftUnit, 3]]);
      r = await run("2026-11-12T05:01:00Z");
      bar("N6a drift → drift alert, reconcile still stamped, alert NOT cleared",
        r.drift === 3 && notified.includes(DRIFT_ALERT) && r.reconcile_done && !cleared.includes(DRIFT_ALERT));
      driftKeys = new Map();
      r = await run("2026-11-13T05:01:00Z");
      bar("N6b next clean night clears the drift alert", r.reconcile_done && cleared.includes(DRIFT_ALERT));

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
