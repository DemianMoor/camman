import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import { formatInTimeZone } from "date-fns-tz";
import {
  foldLifecycleRows,
  lifecycleDayRowsSql,
  lifecycleReportSql,
  type LifecycleReport,
  type LifecycleReportRow,
} from "@/lib/reporting/lifecycle-report";

// ── THE LIFECYCLE DAY ROLLUP (migration 0192) ───────────────────────────────
//
// The Lifecycle report computes cohort CTR per recipient over links + clicks,
// with nothing materialised behind it. Measured on production: 2d ~13-19s,
// 5d ~18s, 7d ~21-26s, 14d ~34s — linear with a large constant, which is why
// the route was capped at 14 days against Overview's 92. This module computes a
// day once and sums it thereafter, which is what lets the cap go back up.
//
// ⚠️ THE ROLLUP AND THE DIRECT QUERY SHARE ONE DEFINITION. `lifecycleDayRowsSql`
// is `lifecycleReportSql` with one extra GROUP BY column — not a re-typed copy.
// Two spellings of "what is a clicker" would agree on the day they were written
// and diverge quietly afterwards, and the whole value of the rollup is that its
// numbers ARE the per-recipient numbers.
//
// ⚠️ COUNTS ARE STORED, RATIOS ARE DERIVED. CTR / CR / opt-out rate come from
// summed numerators and denominators at read time. Storing a per-day ratio and
// averaging it would weight a 200-send day like a 90,000-send one.

/** How far back a refresh recomputes by default. */
export const ROLLUP_LOOKBACK_DAYS = 14;

export interface RollupRefreshResult {
  days: number;
  rows: number;
  durationMs: number;
  from: string;
  to: string;
}

const etToday = () => formatInTimeZone(new Date(), CAMPAIGN_TIMEZONE, "yyyy-MM-dd");
const addEtDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);

type DbOrTx = Pick<typeof db, "execute">;

/**
 * Recompute the rollup for an ET day range and upsert it.
 *
 * ⚠️ A BOUNDED ROLLING WINDOW, NOT AN APPEND. Clicks are scored minutes to hours
 * after the click, conversions arrive on a 15-minute poll, and opt-outs land
 * whenever the recipient replies — so a day's numbers keep moving for a while
 * after the day ends. Recomputing a trailing window is what lets those land;
 * an append-once rollup would freeze each day at whatever was known at midnight.
 *
 * ⚠️ DELETE-THEN-INSERT PER DAY, inside one transaction. An upsert alone cannot
 * remove a (day, cohort) cell that should no longer exist — for example after
 * the reconstruction stamps a send that was previously '__unclassified__'. That
 * cell would otherwise sit there forever, and the cohorts would stop summing to
 * Total, which is exactly the failure the report's Unclassified row exists to
 * make visible.
 */
export async function refreshLifecycleDayRollup(
  dbc: DbOrTx,
  opts: { orgId: string; from?: string; to?: string },
): Promise<RollupRefreshResult> {
  const started = Date.now();
  const to = opts.to ?? etToday();
  const from = opts.from ?? addEtDays(to, -(ROLLUP_LOOKBACK_DAYS - 1));
  const org = sql`${opts.orgId}::uuid`;

  await dbc.execute(sql`
    DELETE FROM lifecycle_day_rollup
    WHERE org_id = ${org} AND et_day BETWEEN ${from}::date AND ${to}::date`);

  const inserted = (await dbc.execute(sql`
    INSERT INTO lifecycle_day_rollup
      (org_id, et_day, cohort, sends, clickers, sales, revenue, opt_outs, cost,
       reconstructed, computed_at)
    SELECT ${org}, d.et_day, d.row, d.sends, d.clickers, d.sales,
           d.revenue::numeric, d.opt_outs, d.cost::numeric, d.reconstructed, now()
    FROM (${lifecycleDayRowsSql({ orgId: opts.orgId, from, to })}) d
    RETURNING et_day`)) as unknown as unknown[];

  const days =
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  return {
    days,
    rows: Array.isArray(inserted) ? inserted.length : 0,
    durationMs: Date.now() - started,
    from,
    to,
  };
}

/**
 * The report: CLOSED ET days from the rollup, TODAY computed live.
 *
 * ⚠️ THE HYBRID IS THE POINT, and it is the same shape Overview's Total Sent
 * uses. A rollup written nightly cannot know about today, so a tab reading it
 * alone would show an empty or half-finished current day — and mid-send-day
 * "today" is exactly the number an operator is watching. Reading today live
 * costs one ET day of per-recipient work (~7-10s at typical volume) on top of a
 * 91-day rollup read that is milliseconds.
 *
 * ⚠️ THE SPLIT IS AT TODAY'S ET MIDNIGHT, and the rollup half is capped BELOW
 * today so a send cannot be counted by both halves. The nightly refresh does
 * write today's partial row while the day is open; it is ignored here rather
 * than deleted, because tomorrow's run will recompute it correctly and a
 * delete would make the table disagree with itself.
 */
export async function getLifecycleReportHybrid(opts: {
  orgId: string;
  from: string;
  to: string;
}): Promise<
  LifecycleReport & { rollup_computed_at: string | null; live_days: number }
> {
  const org = sql`${opts.orgId}::uuid`;
  const today = etToday();
  // The rollup half stops the day BEFORE today; the live half starts at today.
  const rollupTo = opts.to < today ? opts.to : addEtDays(today, -1);
  const liveFrom = opts.from > today ? opts.from : today;
  const hasRollupHalf = opts.from <= rollupTo;
  const hasLiveHalf = opts.to >= today;

  const rollupRows = hasRollupHalf
    ? ((await db.execute(sql`
        SELECT cohort AS row,
               sum(sends)::int AS sends,
               sum(clickers)::int AS clickers,
               sum(sales)::int AS sales,
               sum(revenue)::text AS revenue,
               sum(opt_outs)::int AS opt_outs,
               sum(cost)::text AS cost,
               bool_or(reconstructed) AS reconstructed
        FROM lifecycle_day_rollup
        WHERE org_id = ${org}
          AND et_day BETWEEN ${opts.from}::date AND ${rollupTo}::date
        GROUP BY 1`)) as unknown as LifecycleReportRow[])
    : [];

  const liveRows = hasLiveHalf
    ? ((await db.execute(
        lifecycleReportSql({ orgId: opts.orgId, from: liveFrom, to: opts.to }),
      )) as unknown as LifecycleReportRow[])
    : [];

  // Merge the two halves by cohort before folding, so the ratios the fold
  // derives are over the COMBINED numerators and denominators.
  const merged = new Map<string, LifecycleReportRow>();
  for (const r of [...rollupRows, ...liveRows]) {
    const prev = merged.get(r.row);
    merged.set(
      r.row,
      prev
        ? {
            row: r.row,
            sends: Number(prev.sends) + Number(r.sends),
            clickers: Number(prev.clickers) + Number(r.clickers),
            sales: Number(prev.sales) + Number(r.sales),
            revenue: String(Number(prev.revenue) + Number(r.revenue)),
            opt_outs: Number(prev.opt_outs) + Number(r.opt_outs),
            cost: String(Number(prev.cost) + Number(r.cost)),
            reconstructed: prev.reconstructed || r.reconstructed,
          }
        : r,
    );
  }
  const rows = [...merged.values()];

  // ⚠️ WHEN THE CLOSED HALF WAS LAST COMPUTED — not a count of "missing" days.
  //
  // The obvious signal, "days in the window with no rollup row", CANNOT be
  // computed: a day with zero sends legitimately has no row, and is
  // indistinguishable from a day the job has never touched. Reporting it as
  // stale cried wolf on every quiet Sunday. What an operator can actually act
  // on is how fresh the closed half is, which is one timestamp.
  const computed = hasRollupHalf
    ? ((await db.execute(sql`
        SELECT max(computed_at)::text AS at
        FROM lifecycle_day_rollup
        WHERE org_id = ${org}
          AND et_day BETWEEN ${opts.from}::date AND ${rollupTo}::date`)) as unknown as {
        at: string | null;
      }[])
    : [];

  return {
    ...foldLifecycleRows(rows, opts.from, opts.to),
    rollup_computed_at: computed[0]?.at ?? null,
    live_days: hasLiveHalf ? 1 : 0,
  };
}
