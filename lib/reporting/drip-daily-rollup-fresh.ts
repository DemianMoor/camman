import { sql } from "drizzle-orm";

import type { EtDayRange } from "@/lib/reporting/delivery-rollup";
import {
  BASES,
  DRIP_DAILY_ROLLUP_JOB,
  freshRange,
  parseStamp,
  type Basis,
  type DbOrTx,
  type RefreshResult,
} from "@/lib/reporting/drip-daily-rollup";

// Tier A of /api/cron/drip-daily-rollup — WHEN today's and yesterday's cells are
// recomputed. HOW is refreshDripDailyRollup, untouched.
//
// Until 2026-11-13 every 15-min run recomputed today + yesterday, both bases,
// every drip org (236–331 s of DB time per hour in the afternoon, on a disk at its
// IOPS ceiling). Now:
//   - today refreshes on every run;
//   - yesterday refreshes when its last refresh is ≥ 60 min old, and ALWAYS on the
//     first run after the ET midnight rollover (yesterday just stopped being today).
//
// State: ONE cron_locks row, `drip-daily-rollup:yesterday:<ET day>`, watermark =
// when that day was last refreshed AS yesterday, for every org. The day is in the
// key, so after midnight there is no row yet ⇒ due. Stamped only when every org's
// yesterday refresh succeeded, so a failure is retried on the next tick. Older
// days' rows are deleted.

export const YESTERDAY_STAMP_PREFIX = `${DRIP_DAILY_ROLLUP_JOB}:yesterday:`;
export const YESTERDAY_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
/**
 * Cron start jitter: ticks are 15 min apart but a run starts a few seconds late or
 * early, so "60 min since the stamp" can read 59:58 on the hourly tick and slip to
 * 75 min. Two minutes of slack keeps it on the hour.
 */
const TICK_SLACK_MS = 2 * 60 * 1000;

/** Is yesterday due? `lastRefreshAt` = when THIS ET day was last refreshed as yesterday (null = never ⇒ rollover). Pure. */
export function yesterdayDue(now: Date, lastRefreshAt: Date | null): boolean {
  return lastRefreshAt === null || now.getTime() - lastRefreshAt.getTime() >= YESTERDAY_REFRESH_INTERVAL_MS - TICK_SLACK_MS;
}

export interface FreshOrgResult {
  org_id: string;
  error?: string;
  refreshed?: RefreshResult[];
}

export interface FreshTierDeps {
  db: DbOrTx;
  orgIds: string[];
  now: Date;
  /** Recompute one org × basis over `range` (its own transaction). */
  refresh: (orgId: string, basis: Basis, range: EtDayRange) => Promise<RefreshResult>;
}

/**
 * Tier A. One org's failure does not stop the rest; the caller stamps the tier A
 * heartbeat only when no org errored. Yesterday due ⇒ the SAME two-day call as
 * before; otherwise today alone.
 */
export async function runFreshTier(deps: FreshTierDeps): Promise<{ yesterday_refreshed: boolean; orgs: FreshOrgResult[] }> {
  const range = freshRange(deps.now);
  const key = `${YESTERDAY_STAMP_PREFIX}${range.from}`;
  const rows = (await deps.db.execute(sql`
    SELECT watermark FROM cron_locks WHERE job_name = ${key}`)) as unknown as { watermark: string | null }[];
  const withYesterday = yesterdayDue(deps.now, parseStamp(rows[0]?.watermark));
  const r: EtDayRange = withYesterday ? range : { from: range.to, to: range.to };

  const orgs: FreshOrgResult[] = [];
  for (const org_id of deps.orgIds) {
    try {
      const refreshed: RefreshResult[] = [];
      for (const basis of BASES) refreshed.push(await deps.refresh(org_id, basis, r));
      orgs.push({ org_id, refreshed });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error("[drip-daily-rollup] refresh failed", { org_id, error });
      orgs.push({ org_id, error });
    }
  }
  if (withYesterday && orgs.every((o) => !o.error)) {
    await deps.db.execute(sql`
      INSERT INTO cron_locks (job_name, watermark) VALUES (${key}, ${deps.now.toISOString()}::timestamptz)
      ON CONFLICT (job_name) DO UPDATE SET watermark = EXCLUDED.watermark`);
    await deps.db.execute(sql`
      DELETE FROM cron_locks WHERE job_name LIKE ${`${YESTERDAY_STAMP_PREFIX}%`} AND job_name <> ${key}`);
  }
  return { yesterday_refreshed: withYesterday, orgs };
}
