import { sql } from "drizzle-orm";

import type { db as Db } from "@/db/client";
import { backfillWarmLastClick } from "@/lib/engagement/lifecycle-last-click";
import { reconstructLifecycleDay } from "@/lib/engagement/lifecycle-reconstruct-day";
import { WARM_SPLIT_DAYS, type LifecycleMetrics } from "@/lib/reporting/lifecycle-report";
import { getLifecycleReportHybrid, refreshLifecycleDayRollup } from "@/lib/reporting/lifecycle-rollup";

// THE ONE-SHOT LIFECYCLE BACKFILL — 2026-10-24 quiet window (owner, 2026-10-23).
//
// Three heavy writes the Lifecycle report fixes (#395–#399) need once, run by
// a Vercel cron rather than a session on a laptop so it does not depend on
// anyone being online:
//   1. recon:<day>   status-at-send for the drip sends of 10-06 → 10-23, which
//                    were never stamped (lib/engagement/lifecycle-reconstruct-day)
//   2. lastclick     last_click_at on every warm stamp (the Warm split)
//   3. rollup:<from> recompute lifecycle_day_rollup 06-29 → 10-23, 3 days a unit
// then a Telegram line with before/after totals for 09-23 → 10-22.
//
// ⚠️ ONE-SHOT, DATE-PINNED, SELF-DISABLING. It acts only inside
// [WINDOW_START, WINDOW_END) on 2026-10-24 and is a no-op at any other time,
// forever — the cron entry can then be removed at leisure. Starts no new unit
// after STOP_STARTING, so nothing heavy is still running when the nightly
// engagement job (06:35 UTC) recomputes the rollup.
//
// ⚠️ RESUMABLE BY MARKER. Each finished unit writes a cron_locks row
// `<KEY>:<unit>` (watermark = when). A tick skips finished units, so a killed or
// timed-out invocation loses at most the unit in flight, and that unit is
// itself idempotent (stamps ON CONFLICT DO NOTHING; last_click only where NULL;
// rollup DELETE-then-INSERT). The route holds a lease, so two ticks never run
// units concurrently.
//
// ⚠️ THE COMPLETION MESSAGE IS ITS OWN MARKER, written only when Telegram
// accepted it (notifyTelegram's return value is the only delivery signal), so a
// failed send is retried by the next tick instead of being lost.

export const ONESHOT = {
  key: "lifecycle-backfill-2026-10-24",
  /** Pinned: production has three orgs and this run is for exactly one. */
  orgId: "b0ce3435-5ea2-4510-ab11-8cdd0d0c125b",
  windowStart: new Date("2026-10-24T05:00:00Z"),
  stopStarting: new Date("2026-10-24T06:15:00Z"),
  windowEnd: new Date("2026-10-24T06:20:00Z"),
  reconFrom: "2026-10-06",
  reconTo: "2026-10-23",
  rollupFrom: "2026-06-29",
  rollupTo: "2026-10-23",
  rollupChunkDays: 3,
  reportFrom: "2026-09-23",
  reportTo: "2026-10-22",
  /** Stop starting units this long into one invocation (maxDuration 800s). */
  tickBudgetMs: 540_000,
  /** A recon day whose unevaluated share exceeds this aborts the run. */
  maxUnclassifiedShare: 0.01,
};
export type OneShotConfig = typeof ONESHOT;

/** Before = the production read of 2026-10-23 18:58 UTC, after #399 deployed. */
export const BEFORE_0923_1022 = {
  sends: 1_548_958,
  sales: 840,
  revenue: 29_225.59,
  cost: 15_590.97,
  unclassified: 233_240,
  drip: 0,
  purchases: 0,
  new_clickers: 0,
};

const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dayRange = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

export function plannedUnits(cfg: OneShotConfig = ONESHOT): string[] {
  const recon = dayRange(cfg.reconFrom, cfg.reconTo).map((d) => `recon:${d}`);
  const rollup: string[] = [];
  for (let d = cfg.rollupFrom; d <= cfg.rollupTo; d = addDays(d, cfg.rollupChunkDays)) {
    rollup.push(`rollup:${d}`);
  }
  return [...recon, "lastclick", ...rollup];
}

export interface TickDeps {
  db: typeof Db;
  orgId: string;
  now: () => Date;
  notify: (text: string) => Promise<boolean>;
  cfg?: OneShotConfig;
}

export interface TickResult {
  state: "outside_window" | "already_finished" | "progress" | "complete" | "aborted" | "incomplete";
  ranUnits: string[];
  remaining: number;
  detail?: string;
}

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const int = (n: number) => n.toLocaleString("en-US");

export async function runLifecycleBackfillTick(deps: TickDeps): Promise<TickResult> {
  const cfg = deps.cfg ?? ONESHOT;
  const { db, orgId } = deps;
  const started = deps.now().getTime();
  const marker = (unit: string) => `${cfg.key}:${unit}`;

  const doneRows = (await db.execute(sql`
    SELECT job_name FROM cron_locks
    WHERE job_name LIKE ${`${cfg.key}:%`}`)) as unknown as { job_name: string }[];
  const done = new Set(doneRows.map((r) => r.job_name.slice(cfg.key.length + 1)));
  const mark = async (unit: string) => {
    await db.execute(sql`
      INSERT INTO cron_locks (job_name, watermark) VALUES (${marker(unit)}, now())
      ON CONFLICT (job_name) DO UPDATE SET watermark = now()`);
    done.add(unit);
  };

  const units = plannedUnits(cfg);
  const remaining = () => units.filter((u) => !done.has(u)).length;

  if (done.has("reported") || done.has("aborted") || done.has("incomplete")) {
    return { state: "already_finished", ranUnits: [], remaining: remaining() };
  }
  const now = deps.now();
  if (now < cfg.windowStart) return { state: "outside_window", ranUnits: [], remaining: remaining() };
  if (now >= cfg.windowEnd) {
    // Past the window and never finished: say so ONCE (marker only on delivery).
    if (remaining() === 0 && !done.has("reported")) {
      // Work finished but the message never went out — fall through to report.
    } else {
      const ok = await deps.notify(
        `⚠️ Lifecycle backfill INCOMPLETE — quiet window closed with ` +
          `${remaining()} of ${units.length} units left. Finished: ` +
          `${units.length - remaining()}. Nothing further will run; re-run the ` +
          `remaining steps from scripts/ in the next quiet window.`,
      );
      if (ok) await mark("incomplete");
      return { state: "incomplete", ranUnits: [], remaining: remaining() };
    }
  }

  if (!done.has("start")) {
    const ok = await deps.notify(
      `▶️ Lifecycle backfill started (${now.toISOString().slice(11, 16)} UTC): ` +
        `${units.length} units — drip status ${cfg.reconFrom}→${cfg.reconTo}, ` +
        `warm last-click times, rollup ${cfg.rollupFrom}→${cfg.rollupTo}.`,
    );
    void ok; // best-effort: the start line gates nothing
    await mark("start");
  }

  const ran: string[] = [];
  for (const unit of units) {
    if (done.has(unit)) continue;
    const t = deps.now();
    if (t >= cfg.stopStarting || t.getTime() - started > cfg.tickBudgetMs) {
      return { state: "progress", ranUnits: ran, remaining: remaining() };
    }
    if (unit.startsWith("recon:")) {
      const day = unit.slice("recon:".length);
      const out = await db.transaction((tx) =>
        reconstructLifecycleDay(tx, { orgId, day, apply: true }),
      );
      if (out.target > 0 && out.unclassified / out.target > cfg.maxUnclassifiedShare) {
        const ok = await deps.notify(
          `⛔ Lifecycle backfill ABORTED at ${day}: ${int(out.unclassified)} of ` +
            `${int(out.target)} unstamped sends could not be evaluated ` +
            `(> ${(cfg.maxUnclassifiedShare * 100).toFixed(0)}%). ${int(out.written)} ` +
            `stamped for that day; nothing further will run.`,
        );
        if (ok) await mark("aborted");
        return { state: "aborted", ranUnits: ran, remaining: remaining(), detail: day };
      }
    } else if (unit === "lastclick") {
      await db.transaction((tx) =>
        backfillWarmLastClick(tx, { orgId, apply: true, splitDays: WARM_SPLIT_DAYS }),
      );
    } else if (unit.startsWith("rollup:")) {
      const from = unit.slice("rollup:".length);
      const last = addDays(from, cfg.rollupChunkDays - 1);
      const to = last > cfg.rollupTo ? cfg.rollupTo : last;
      await refreshLifecycleDayRollup(db, { orgId, from, to });
    }
    await mark(unit);
    ran.push(unit);
  }

  // Every unit done: the after numbers, and the one Telegram line.
  const rep = await getLifecycleReportHybrid({ orgId, from: cfg.reportFrom, to: cfg.reportTo });
  const row = (k: string): LifecycleMetrics | undefined => rep.rows.find((r) => r.row === k);
  const g = row("grand_total");
  const after = {
    sends: g?.sends ?? 0,
    sales: g?.sales ?? 0,
    purchases: g?.purchases ?? 0,
    new_clickers: g?.new_clickers ?? 0,
    revenue: Number(g?.revenue ?? 0),
    cost: Number(g?.cost ?? 0),
    unclassified: row("unclassified")?.sends ?? 0,
    drip: row("drip")?.sends ?? 0,
    warmNoClick: row("warm")?.sends ?? 0,
  };
  const b = BEFORE_0923_1022;
  const text =
    `✅ Lifecycle backfill complete (${deps.now().toISOString().slice(11, 16)} UTC). ` +
    `Report ${cfg.reportFrom}→${cfg.reportTo}, before → after:\n` +
    `Grand total sends ${int(b.sends)} → ${int(after.sends)}\n` +
    `Sales ${int(b.sales)} → ${int(after.sales)} · Purchases ${int(b.purchases)} → ${int(after.purchases)}\n` +
    `Revenue ${money(b.revenue)} → ${money(after.revenue)} · Cost ${money(b.cost)} → ${money(after.cost)}\n` +
    `Unclassified ${int(b.unclassified)} → ${int(after.unclassified)} · Drip ${int(b.drip)} → ${int(after.drip)}\n` +
    `New clickers ${int(b.new_clickers)} → ${int(after.new_clickers)} · Warm with no click time: ${int(after.warmNoClick)}`;
  if (await deps.notify(text)) await mark("reported");
  return { state: "complete", ranUnits: ran, remaining: 0, detail: text };
}
