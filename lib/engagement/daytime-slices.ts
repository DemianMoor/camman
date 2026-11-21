import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { clearAlert, notifyOnTransition } from "@/lib/alerts/alert-state";
import {
  DAYTIME_BUDGET_MS,
  DAYTIME_LAG_ALERT_MINUTES,
  DAYTIME_SLICE_MAX_TOUCHED,
  engagementCursorJob,
} from "@/lib/engagement/constants";
import { refreshContactEngagement, type RefreshResult } from "@/lib/engagement/refresh";
import { HUMAN_CLICK } from "@/lib/reporting/counted-clickers";
import type { DbOrTx } from "@/lib/reporting/cron-heartbeat";

// =============================================================================
// DAYTIME ENGAGEMENT REFRESH — time slices, never an org-wide recount
// (plan: docs/superpowers/plans/2026-11-17-engagement-refresh-daytime-incremental-plan.md)
//
// During 08:00–22:00 ET the 15-min tick recounts ONLY the contacts touched in
// its window, cut into time slices of at most DAYTIME_SLICE_MAX_TOUCHED
// contacts. Each slice is its own transaction and advances this org's cursor
// (cron_locks `contact-engagement-cursor:<org>`) to the slice's end, so a burst
// is worked off over several ticks without redoing finished slices. The
// time-due evaluation runs once per tick, on the first slice, so it can never be
// starved by the budget. Before 2026-11-17 a touched set over 20,000 escalated
// to an org-wide recount on every afternoon tick (45–312 s each), which evicted
// the audience snapshot's working set (contact_engagement heap hit 32.8%).
// =============================================================================

export interface MinuteBucket {
  /** Start of the minute. */
  minute: Date;
  /** Distinct contacts touched in that minute (sends ∪ scored human clicks). */
  n: number;
}

/**
 * Cut [from, to] into slices whose touched counts stay at or under `max`.
 * Bucket counts are distinct per minute, so their sum over-counts a contact
 * touched in two minutes — a slice can only come out SMALLER than planned,
 * never larger. A single minute over `max` is its own slice (a minute is the
 * smallest unit). Always returns at least one slice, ending exactly at `to`.
 * Pure.
 */
export function packSlices(buckets: MinuteBucket[], from: Date, to: Date, max: number): Date[] {
  const ends: Date[] = [];
  let acc = 0;
  const sorted = [...buckets].sort((a, b) => a.minute.getTime() - b.minute.getTime());
  for (const b of sorted) {
    if (b.minute.getTime() < from.getTime() || b.minute.getTime() >= to.getTime()) continue;
    if (acc > 0 && acc + b.n > max) {
      ends.push(b.minute); // the slice ends where this minute starts
      acc = 0;
    }
    acc += b.n;
  }
  ends.push(to);
  return ends;
}

async function minuteBuckets(dbc: DbOrTx, orgId: string, from: Date, to: Date): Promise<MinuteBucket[]> {
  const f = sql`${from.toISOString()}::timestamptz`;
  const t = sql`${to.toISOString()}::timestamptz`;
  const rows = (await dbc.execute(sql`
    SELECT minute, count(DISTINCT contact_id)::int AS n FROM (
      SELECT date_trunc('minute', sent_at) AS minute, contact_id FROM stage_sends
       WHERE org_id = ${orgId}::uuid AND sent_at >= ${f} AND sent_at <= ${t} AND status = 'sent'
      UNION ALL
      SELECT date_trunc('minute', ck.scored_at), l.contact_id FROM clicks ck JOIN links l ON l.id = ck.link_id
       WHERE ${HUMAN_CLICK} AND ck.org_id = ${orgId}::uuid AND ck.scored_at >= ${f} AND ck.scored_at <= ${t}
    ) x GROUP BY 1`)) as unknown as { minute: string | Date; n: number }[];
  return rows.map((r) => ({ minute: new Date(r.minute), n: Number(r.n) }));
}

export interface DaytimeRunResult {
  slices: number;
  slicesPlanned: number;
  caughtUp: boolean;
  /** now − cursor after the run, in minutes. */
  lagMinutes: number;
  recounted: number;
  maxSliceRecounted: number;
  results: RefreshResult[];
}

/**
 * One org's daytime tick. `cursor` is where this org's previous slice ended;
 * the first slice starts `overlapMinutes` before it (a send whose sent_at
 * predates its commit is still caught). Throws on a failed slice — the slices
 * before it are committed and the cursor stays at the last good one.
 */
export async function runDaytimeSlices(opts: {
  orgId: string;
  cursor: Date;
  overlapMinutes: number;
  evaluateAll: boolean;
  /** How each slice reaches its contacts' sends — see RefreshOptions.daytimeSlice. */
  recount: "per_contact" | "set";
  /** Test seams. */
  maxTouched?: number;
  budgetMs?: number;
  now?: () => Date;
  /** Test seam: called after slice i committed (throw here to simulate a killed run). */
  afterSlice?: (i: number) => void;
}): Promise<DaytimeRunResult> {
  const dbc = db;
  const now = opts.now ?? (() => new Date());
  const started = Date.now();
  const to = now();
  const from = new Date(opts.cursor.getTime() - opts.overlapMinutes * 60_000);
  const max = opts.maxTouched ?? DAYTIME_SLICE_MAX_TOUCHED;
  const ends = packSlices(await minuteBuckets(dbc, opts.orgId, from, to), from, to, max);

  const results: RefreshResult[] = [];
  let sliceFrom = from;
  let cursor = opts.cursor;
  for (const [i, until] of ends.entries()) {
    if (i > 0 && Date.now() - started > (opts.budgetMs ?? DAYTIME_BUDGET_MS)) break;
    const r = await dbc.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '600s'"));
      const res = await refreshContactEngagement(tx, opts.orgId, {
        mode: "incremental",
        dryRun: false,
        since: sliceFrom,
        // First slice only: the threshold re-evaluation (if requested) and the
        // time-due pass, so neither waits on a burst.
        evaluateAll: i === 0 && opts.evaluateAll,
        daytimeSlice: { until, evaluateTimeDue: i === 0, recount: opts.recount },
        maxTouched: max,
      });
      // The cursor moves in the SAME transaction as the slice's writes.
      await tx.execute(sql`
        INSERT INTO cron_locks (job_name, watermark)
        VALUES (${engagementCursorJob(opts.orgId)}, ${until.toISOString()}::timestamptz)
        ON CONFLICT (job_name) DO UPDATE SET watermark = EXCLUDED.watermark`);
      return res;
    });
    results.push(r);
    cursor = until;
    sliceFrom = until;
    opts.afterSlice?.(i);
  }
  const caughtUp = cursor.getTime() >= to.getTime();
  return {
    slices: results.length,
    slicesPlanned: ends.length,
    caughtUp,
    lagMinutes: Math.max(0, Math.round((now().getTime() - cursor.getTime()) / 60_000)),
    recounted: results.reduce((a, r) => a + r.recounted, 0),
    maxSliceRecounted: results.reduce((a, r) => Math.max(a, r.recounted), 0),
    results,
  };
}

// alert_state is unique on alert_key alone, so the org is part of the key.
export const engagementLagAlertKey = (orgId: string) => `contact-engagement-lag:${orgId}`;

/**
 * Pages once when a daytime tick ends more than DAYTIME_LAG_ALERT_MINUTES behind,
 * clears when a tick ends within it. Latched per org (alert-state), so a burst
 * that stays behind for several ticks sends one message.
 */
export async function reportEngagementLag(
  dbc: DbOrTx,
  orgId: string,
  lagMinutes: number,
  send?: (text: string) => Promise<boolean>,
): Promise<"paged_or_latched" | "clear"> {
  if (lagMinutes > DAYTIME_LAG_ALERT_MINUTES) {
    await notifyOnTransition(dbc, {
      alertKey: engagementLagAlertKey(orgId),
      orgId,
      text:
        `⚠️ Contact lifecycle refresh is ${lagMinutes} min behind (limit ${DAYTIME_LAG_ALERT_MINUTES}). ` +
        `Freeze cadence and suppression for contacts messaged in that time are not updated yet; ` +
        `the job keeps working through the backlog in slices. Check /api/cron/refresh-contact-engagement in Vercel.`,
      send,
    });
    return "paged_or_latched";
  }
  await clearAlert(dbc, { alertKey: engagementLagAlertKey(orgId), orgId });
  return "clear";
}
