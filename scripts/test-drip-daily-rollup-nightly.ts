import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  DRIP_DAILY_ROLLUP_RECONCILE_JOB,
  DRIP_DAILY_ROLLUP_SETTLE_JOB,
  type Basis,
  type CellDiff,
  type ClickRepair,
  type NightlyUnit,
} from "@/lib/reporting/drip-daily-rollup";
import {
  DRIFT_ALERT,
  MAX_NIGHTLY_REPAIR_CELLS,
  MAX_NIGHTLY_REPAIR_CLICKS,
  NIGHTLY_INCOMPLETE_ALERT,
  NIGHTLY_RUN_BUDGET_MS,
  REPAIR_GUARD_ALERT,
  REPAIR_GUARD_JOB,
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

      // A scripted world: which units throw, which diffs each reconcile returns,
      // how long each takes. Repairs land in an in-memory trail (the DB writer
      // has its own bars in test-drip-daily-rollup.ts).
      let failKeys = new Set<string>();
      let diffKeys = new Map<string, CellDiff[]>();
      let unitSleepMs = 0;
      const attempts = new Map<string, number>();
      let notified: string[] = [];
      let notifiedText = new Map<string, string>();
      let cleared: string[] = [];
      let lastIncompleteText = "";
      let trail: { at: Date; unit: string; r: ClickRepair }[] = [];
      // A cell's diff as diffDripDailyRollup returns it (counters as text).
      const base = { campaign_id: 7, stage_id: 70, partner_key_id: 77, first_sends: "3", delivered: "2", sales: "0", revenue: "0.0000" };
      let seq = 0;
      const cell = (basis: Basis, storedOver: Record<string, unknown> | null, liveOver: Record<string, unknown> | null): CellDiff => {
        const day_et = `2026-10-${String(10 + (seq++ % 18)).padStart(2, "0")}`;
        const stored = storedOver && { ...base, day_et, stage_id: 70 + seq, ...storedOver };
        const live = liveOver && { ...base, day_et, stage_id: 70 + seq, ...liveOver };
        return { basis, key: `7/${day_et}/${70 + seq}/77`, stored, live };
      };
      const lateClick = (from: number, to: number) => cell("cohort", { clicks: String(from) }, { clicks: String(to) });
      const lateClicks = (n: number, add = 1) => Array.from({ length: n }, () => lateClick(2, 2 + add));
      const work = async (u: NightlyUnit) => {
        attempts.set(u.key, (attempts.get(u.key) ?? 0) + 1);
        if (unitSleepMs) await new Promise((r) => setTimeout(r, unitSleepMs));
        if (failKeys.has(u.key)) throw new Error(`scripted failure ${u.key}`);
      };
      const run = (nowIso: string, runStartedMs = Date.now()) => {
        notified = [];
        notifiedText = new Map();
        cleared = [];
        const deps: NightlyDeps = {
          db: tx,
          orgIds: ["00000000-0000-0000-0000-000000000000"],
          now: () => at(nowIso),
          runStartedMs,
          settle: async (_o, u) => work(u),
          reconcile: async (_o, u) => {
            await work(u);
            return diffKeys.get(u.key) ?? [];
          },
          repair: async (_o, unitKey, repairs) => {
            for (const r of repairs) trail.push({ at: at(nowIso), unit: unitKey, r });
            return repairs.length;
          },
          repairTotals: async (_o, since) => {
            const t = trail.filter((x) => x.at >= since);
            return { cells: t.length, clicks: t.reduce((a, x) => a + x.r.new_clicks - x.r.old_clicks, 0) };
          },
          notify: async (k, text) => {
            notified.push(k);
            notifiedText.set(k, text);
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
      diffKeys = new Map([[driftUnit, [1, 2, 3].map(() => cell("activity", { clicks: "1" }, { clicks: "2" }))]]);
      r = await run("2026-11-12T05:01:00Z");
      bar("N6a drift → drift alert, reconcile still stamped, alert NOT cleared",
        r.drift === 3 && notified.includes(DRIFT_ALERT) && r.reconcile_done && !cleared.includes(DRIFT_ALERT));
      diffKeys = new Map();
      r = await run("2026-11-13T05:01:00Z");
      bar("N6b next clean night clears the drift alert", r.reconcile_done && cleared.includes(DRIFT_ALERT));

      // N7 — late cohort clicks are repaired, logged, and are NOT drift.
      const coh = (i: number) => `${DRIP_DAILY_ROLLUP_RECONCILE_JOB}:cohort:${i}`;
      const act = (i: number) => `${DRIP_DAILY_ROLLUP_RECONCILE_JOB}:activity:${i}`;
      await reset();
      trail = [];
      diffKeys = new Map([[coh(0), [lateClick(2, 5), lateClick(0, 1)]], [coh(2), [lateClick(4, 6)]]]);
      r = await run("2026-11-14T05:01:00Z");
      bar("N7a click-only cohort cells (fresh > stored) are repaired: 3 cells / +6 clicks, in the run result",
        r.repaired_cells === 3 && r.repaired_clicks === 6 && trail.length === 3, `${r.repaired_cells} / ${r.repaired_clicks}`);
      bar("N7b each repair logged with cell + old + new value",
        trail.some((x) => x.unit === coh(0) && x.r.old_clicks === 2 && x.r.new_clicks === 5 && x.r.campaign_id === 7 && x.r.partner_key_id === 77));
      bar("N7c repairs are not drift: no drift alert, and the drift alert CLEARS that night",
        r.drift === 0 && !notified.includes(DRIFT_ALERT) && cleared.includes(DRIFT_ALERT) && r.reconcile_done);
      bar("N7d nightly count of repaired cells in the run result", r.night_repaired_cells === 3, String(r.night_repaired_cells));
      diffKeys = new Map();
      r = await run("2026-11-14T05:16:00Z");
      bar("N7e a later run the same night still reports the night's count", r.ran.length === 0 && r.night_repaired_cells === 3 && r.repaired_cells === 0);

      // N8 — everything that is NOT a late cohort click alerts exactly as before and is not repaired.
      await reset();
      trail = [];
      const sendsAndClicks = cell("cohort", { clicks: "2", first_sends: "3" }, { clicks: "3", first_sends: "4" });
      const revenueOnly = cell("cohort", { revenue: "5.0000" }, { revenue: "9.0000" });
      const missing = cell("cohort", null, { clicks: "1" });
      const negative = lateClick(5, 3);
      diffKeys = new Map([
        [act(0), [cell("activity", { clicks: "2" }, { clicks: "3" })]],
        [coh(0), [sendsAndClicks, revenueOnly, lateClick(1, 2)]],
        [coh(1), [missing, negative]],
      ]);
      r = await run("2026-11-15T05:01:00Z");
      bar("N8a activity-basis click diff, cohort sends+clicks / revenue diffs, a missing cell and stored>fresh → 5 drift, alert",
        r.drift === 5 && notified.includes(DRIFT_ALERT), `drift ${r.drift}`);
      bar("N8b only the one clean late-click cell was repaired", r.repaired_cells === 1 && trail.length === 1 && trail[0].r.new_clicks === 2);
      bar("N8c stored clicks ABOVE fresh: counted as negative, alerted, not repaired",
        r.negative === 1 && /ABOVE fresh/.test(notifiedText.get(DRIFT_ALERT) ?? "") && !trail.some((x) => x.r.old_clicks === 5));
      bar("N8d drift night: the drift alert is NOT cleared", !cleared.includes(DRIFT_ALERT));

      // N9 — the guard: an abnormal night alerts instead of repairing, for the rest of that night.
      await reset();
      trail = [];
      diffKeys = new Map([[coh(0), lateClicks(20)], [coh(1), lateClicks(MAX_NIGHTLY_REPAIR_CELLS - 20 + 1)], [coh(2), lateClicks(2)]]);
      r = await run("2026-11-16T05:01:00Z");
      bar(`N9a cells over ${MAX_NIGHTLY_REPAIR_CELLS} tonight → guard alert, the unit that would cross it is withheld`,
        notified.includes(REPAIR_GUARD_ALERT) && r.repair_guard_tripped && r.repaired_cells === 20 &&
          trail.length === 20 && r.repairs_withheld === MAX_NIGHTLY_REPAIR_CELLS - 20 + 1 + 2,
        `repaired ${r.repaired_cells}, withheld ${r.repairs_withheld}`);
      bar("N9b after the trip, later units that night are withheld too (even small ones)", !trail.some((x) => x.unit === coh(2)));
      bar("N9c guard stamped; guard alert NOT cleared that night; withheld cells are not drift",
        (await wm(REPAIR_GUARD_JOB)) !== null && !cleared.includes(REPAIR_GUARD_ALERT) && r.drift === 0);
      // A new run the same night: still tripped (from the stamp), nothing repaired, no second message.
      diffKeys = new Map([[coh(3), lateClicks(1)]]);
      await tx.execute(sql`DELETE FROM cron_locks WHERE job_name = ${coh(3)}`);
      r = await run("2026-11-16T05:16:00Z");
      bar("N9d next run same night: still withheld, alert not re-sent by runNightly's state",
        r.repair_guard_tripped && r.repaired_cells === 0 && r.repairs_withheld === 1 && !notified.includes(REPAIR_GUARD_ALERT));
      diffKeys = new Map([[coh(0), lateClicks(10, 16)]]);
      r = await run("2026-11-17T05:01:00Z");
      bar(`N9e clicks over ${MAX_NIGHTLY_REPAIR_CLICKS} (10 cells × +16) also trips the guard`,
        r.repair_guard_tripped && r.repaired_cells === 0 && notified.includes(REPAIR_GUARD_ALERT));
      diffKeys = new Map([[coh(0), lateClicks(3)]]);
      r = await run("2026-11-18T05:01:00Z");
      bar("N9f next normal night: repairs resume, the guard alert clears",
        !r.repair_guard_tripped && r.repaired_cells === 3 && cleared.includes(REPAIR_GUARD_ALERT));
      bar(`N9g at the cap exactly (${MAX_NIGHTLY_REPAIR_CELLS} cells / ${MAX_NIGHTLY_REPAIR_CLICKS} clicks) is allowed`,
        await (async () => {
          await reset();
          trail = [];
          diffKeys = new Map([[coh(0), [...lateClicks(MAX_NIGHTLY_REPAIR_CELLS - 1), lateClick(0, MAX_NIGHTLY_REPAIR_CLICKS - (MAX_NIGHTLY_REPAIR_CELLS - 1))]]]);
          const x = await run("2026-11-19T05:01:00Z");
          return !x.repair_guard_tripped && x.repaired_cells === MAX_NIGHTLY_REPAIR_CELLS && x.repaired_clicks === MAX_NIGHTLY_REPAIR_CLICKS;
        })());

      // N10 — the start budget is 90 s (owner, 2026-11-12).
      bar("N10 NIGHTLY_RUN_BUDGET_MS = 90 000", NIGHTLY_RUN_BUDGET_MS === 90_000, String(NIGHTLY_RUN_BUDGET_MS));

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
