import { sql } from "drizzle-orm";

import type { db } from "@/db/client";

// Blind-spot watch for the opt-out-rate breaker's aligned numerator.
//
// The numerator joins opt_out_attributions -> stage_sends on `stage_send_id` so
// STOPs are counted against the send that produced them
// (lib/sends/circuit-breakers.ts). Rows with a NULL `stage_send_id` cannot be
// aligned and are dropped from the numerator — deliberately, because the only
// alternative (falling back to oa.stage_id + oa.created_at) reintroduces the
// receipt-time bucketing that caused the 2026-07-25 false trips.
//
// Dropping them is safe only while the population is negligible. It is today
// (0 of 43,487 rows all-time), but `stage_send_id` is ON DELETE SET NULL, so a
// future prune of stage_sends could silently start starving the breaker's
// numerator — a breaker that quietly stops seeing STOPs is worse than one that
// trips wrongly. This check makes that observable.
//
// Read-only, and deliberately NOT on the hot path: putting it in
// checkOptOutRateBreaker would add a query to EVERY STOP and, once breached,
// alert on every STOP with no dedup. It runs on the hourly Telegram cron
// instead, next to the backlog-stall detector.

export interface UnjoinableAttributionStats {
  /** Attributions in the window with a NULL stage_send_id. */
  nulls: number;
  /** All attributions in the window. */
  total: number;
  /** nulls / total, 0 when the window is empty. */
  pct: number;
  window_hours: number;
}

/** Share of unjoinable rows that warrants an alert. */
export const UNJOINABLE_ALERT_PCT = 0.05;
/**
 * Sample floor. Without it a quiet window (1 unjoinable row of 3) alerts at
 * 33% every hour — the same small-sample noise the breaker's own min-send floor
 * exists to avoid.
 */
export const UNJOINABLE_MIN_TOTAL = 20;

export async function findUnjoinableOptOutAttributions(
  dbc: typeof db,
  opts: { windowHours: number },
): Promise<UnjoinableAttributionStats> {
  const { windowHours } = opts;
  const rows = (await dbc.execute(sql`
    SELECT count(*) FILTER (WHERE stage_send_id IS NULL)::int AS nulls,
           count(*)::int AS total
    FROM opt_out_attributions
    WHERE created_at > now() - make_interval(hours => ${windowHours})
  `)) as unknown as { nulls: number; total: number }[];
  const nulls = Number(rows[0]?.nulls ?? 0);
  const total = Number(rows[0]?.total ?? 0);
  return { nulls, total, pct: total > 0 ? nulls / total : 0, window_hours: windowHours };
}

/** Whether the stats warrant an alert. Pure — caller decides whether to send. */
export function shouldAlertUnjoinable(s: UnjoinableAttributionStats): boolean {
  return s.total >= UNJOINABLE_MIN_TOTAL && s.pct > UNJOINABLE_ALERT_PCT;
}

/** Human-readable Telegram alert body. Pure. */
export function formatUnjoinableAlert(s: UnjoinableAttributionStats): string {
  return (
    `⚠️ Opt-out attributions are losing their send link — ` +
    `${s.nulls}/${s.total} (${(s.pct * 100).toFixed(1)}%) in the last ${s.window_hours}h ` +
    `have a NULL stage_send_id.\n` +
    `Those STOPs are INVISIBLE to the opt-out-rate breaker's numerator, which counts ` +
    `each STOP against the send that produced it. The breaker is under-reading by that much.\n` +
    `Check what is clearing stage_sends rows (stage_send_id is ON DELETE SET NULL) or ` +
    `what is writing attributions without a matched send.`
  );
}
