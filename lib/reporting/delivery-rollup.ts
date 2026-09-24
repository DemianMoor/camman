import { sql } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";

import { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE, formatInCampaignTimezone } from "@/lib/campaign-timezone";
import {
  DELIVERY_COUNTS,
  terminalCte,
  type DbOrTx,
  type DeliveryStageRow,
} from "@/lib/reporting/delivery";

// =============================================================================
// STAGE DELIVERY ROLLUP (migration 0186, ClickUp 869f5q5au)
//
// stage_delivery_rollup holds the live delivery query's four counts per
// (stage, number, SEND ET day). A report window is then a sum over a few
// hundred rows (22–29 ms for 1/7/14 days, measured on prod data) instead of a
// read of every send and every receipt in the window (0.5 s / 16.5 s / 20.2 s).
//
// ⚠️ ONE DEFINITION. Cells are computed with the live query's own fragments —
// terminalCte (per-source fold BEFORE the join, lower() on status, the
// received_at early-arrival margin) and DELIVERY_COUNTS (delivered wins,
// no_receipt = NOT (d OR u)) — imported from lib/reporting/delivery.ts, never
// retyped. The live query stays, and the nightly reconciliation diffs the two.
//
// ⚠️ ONLY WRITER. The refresh job (app/api/cron/delivery-rollup) and the one-off
// backfill (scripts/backfill-delivery-rollup.ts) write here, through
// refreshDeliveryRollup. Nothing on stage_sends or the DLR intake path changes.
//
// SCOPE IS THE SEND'S ET DAY, not the stage. campaign_stages.sent_at is the
// scheduler's fire stamp: NULL on 3 stages that really sent, and re-stamped up
// to 4h12m after a stage's first send (measured 2026-09-22). The send's own
// sent_at is what the rollup is keyed on, so it is what the refresh scopes by.
// =============================================================================

/**
 * Tier A: TODAY only (ET), every run.
 *
 * It covered today + yesterday until 2026-09-23, which made this job the #3
 * consumer on the database: measured over 21.5 h of production, 129 runs at
 * 6.96 s and ~267 MB each — **~34 GB/day** — because every tick re-read
 * yesterday's sends and two days of receipts. Yesterday's pages are rarely
 * still cached ten minutes later, so most runs paid the cold price.
 *
 * Measured per run, same org, rolled-back transactions (2026-09-23):
 *   today + yesterday   2.6 s warm / 8.1 s cold · 12,787–44,101 blocks (100–345 MB)
 *   today only          0.43–0.47 s             · 0–2 blocks
 *
 * Yesterday is not dropped — the 7-day settle below still recomputes it every
 * 3 h, so a late receipt for yesterday lands within that window instead of
 * within ten minutes. That is a freshness trade the UI already states: the
 * "as of" label on Delivered % shows the OLDER stamp a window depends on, so a
 * window including yesterday now honestly reports the settle time.
 *
 * ⚠️ `sent` for yesterday is NOT affected by this: a send is stamped when it
 * goes out, so yesterday's cells stop changing at midnight; only
 * delivered/undelivered evolve with receipts. That is what lets the Overview's
 * Total Sent read yesterday's cells while counting today live.
 */
export const FRESH_DAYS = 1;
/**
 * Tier B: the last 7 ET days, at most every SETTLE_EVERY_HOURS. Cells OLDER than
 * this are final and never recomputed — 0 of 2.64M terminal receipts ever
 * arrived ≥ 6 days after their send (max 5 d 00:02, measured 2026-09-22), and a
 * day's youngest send is ~5 d 21 h old when its cell leaves this window. The
 * nightly reconciliation is what notices if that ever stops being true.
 */
export const SETTLE_DAYS = 7;
export const SETTLE_EVERY_HOURS = 3;
/** The reconciliation checks a 7-day window of FROZEN cells ending this many days ago. */
export const RECONCILE_END_AGE_DAYS = SETTLE_DAYS;
export const RECONCILE_WINDOW_DAYS = 7;

// cron_locks rows. Heartbeat expectations live in lib/reporting/cron-heartbeat.ts.
export const DELIVERY_ROLLUP_JOB = "delivery-rollup";
export const DELIVERY_ROLLUP_SETTLE_JOB = "delivery-rollup-settle";
export const DELIVERY_ROLLUP_RECONCILE_JOB = "delivery-rollup-reconcile";

/** Inclusive range of America/New_York calendar days, yyyy-MM-dd. */
export interface EtDayRange {
  from: string;
  to: string;
}

export function addEtDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function etDayBounds(r: EtDayRange): { fromUtc: Date; toExclusiveUtc: Date } {
  return {
    fromUtc: fromZonedTime(`${r.from}T00:00:00`, CAMPAIGN_TIMEZONE),
    toExclusiveUtc: fromZonedTime(`${addEtDays(r.to, 1)}T00:00:00`, CAMPAIGN_TIMEZONE),
  };
}

export interface RollupScope {
  range: EtDayRange;
  settle: boolean;
}

/**
 * What one run recomputes. Pure, so the tier logic is testable without a DB:
 * tier A (today + yesterday) always; widened to tier B (7 days) when the last
 * successful settle is missing or at least SETTLE_EVERY_HOURS old.
 */
export function rollupScope(now: Date, lastSettle: Date | null): RollupScope {
  const today = formatInCampaignTimezone(now, "yyyy-MM-dd");
  // An unparseable stamp counts as "never": NaN compares false, and without this
  // guard a bad stamp would silently stop the settle forever. (cron_locks
  // watermarks arrive from drizzle's execute() as STRINGS, not Dates — Node
  // parses Postgres' format, but that is an engine behaviour, not a contract.)
  const settle =
    lastSettle == null ||
    Number.isNaN(lastSettle.getTime()) ||
    now.getTime() - lastSettle.getTime() >= SETTLE_EVERY_HOURS * 3_600_000;
  const days = settle ? SETTLE_DAYS : FRESH_DAYS;
  return { range: { from: addEtDays(today, -(days - 1)), to: today }, settle };
}

/** The frozen window the nightly reconciliation checks. */
export function reconcileRange(now: Date): EtDayRange {
  const today = formatInCampaignTimezone(now, "yyyy-MM-dd");
  const to = addEtDays(today, -RECONCILE_END_AGE_DAYS);
  return { from: addEtDays(to, -(RECONCILE_WINDOW_DAYS - 1)), to };
}

export interface RefreshResult {
  /** Cells the window holds now. */
  cells: number;
  /** Cells inserted or changed. Unchanged cells are not rewritten. */
  written: number;
  /** Stored cells in the window that no longer exist (e.g. a send left 'sent'). */
  deleted: number;
  durationMs: number;
}

/**
 * Recompute every cell of one org whose SEND ET day is in `range`, in ONE
 * statement: compute, upsert the cells whose counts changed, delete the ones
 * that vanished. Caller owns the transaction and its statement_timeout.
 *
 * The receipt side is bounded by the window start minus the early-arrival
 * margin (terminalCte), exactly as the live query is.
 */
export async function refreshDeliveryRollup(
  dbc: DbOrTx,
  orgId: string,
  range: EtDayRange,
): Promise<RefreshResult> {
  const started = Date.now();
  const { fromUtc, toExclusiveUtc } = etDayBounds(range);
  const from = sql`${fromUtc.toISOString()}::timestamptz`;
  const to = sql`${toExclusiveUtc.toISOString()}::timestamptz`;

  const rows = (await dbc.execute(sql`
    WITH sends AS (
      SELECT id, stage_id, provider_phone_id,
             (sent_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date AS sent_date_et
      FROM stage_sends
      WHERE org_id = ${orgId}::uuid
        AND status = 'sent'
        AND sent_at >= ${from} AND sent_at < ${to}
    ),
    terminal AS (${terminalCte(from)}),
    fresh AS (
      SELECT s.stage_id, s.provider_phone_id, s.sent_date_et, ${DELIVERY_COUNTS}
      FROM sends s
      LEFT JOIN terminal t ON t.ss_id = s.id
      GROUP BY 1, 2, 3
    ),
    written AS (
      INSERT INTO stage_delivery_rollup AS r
        (org_id, stage_id, provider_phone_id, sent_date_et, sent, delivered, undelivered, no_receipt, refreshed_at)
      SELECT ${orgId}::uuid, stage_id, provider_phone_id, sent_date_et,
             sent, delivered, undelivered, no_receipt, now()
      FROM fresh
      ON CONFLICT (stage_id, provider_phone_id, sent_date_et) DO UPDATE
        SET sent = EXCLUDED.sent,
            delivered = EXCLUDED.delivered,
            undelivered = EXCLUDED.undelivered,
            no_receipt = EXCLUDED.no_receipt,
            refreshed_at = EXCLUDED.refreshed_at
        -- An unchanged cell is not rewritten: no dead tuple, no WAL, and
        -- refreshed_at keeps meaning "last time this cell's counts moved".
        WHERE (r.sent, r.delivered, r.undelivered, r.no_receipt)
              IS DISTINCT FROM (EXCLUDED.sent, EXCLUDED.delivered, EXCLUDED.undelivered, EXCLUDED.no_receipt)
      RETURNING 1
    ),
    deleted AS (
      DELETE FROM stage_delivery_rollup r
      WHERE r.org_id = ${orgId}::uuid
        AND r.sent_date_et BETWEEN ${range.from}::date AND ${range.to}::date
        AND NOT EXISTS (
          SELECT 1 FROM fresh f
          WHERE f.stage_id = r.stage_id
            AND f.provider_phone_id IS NOT DISTINCT FROM r.provider_phone_id
            AND f.sent_date_et = r.sent_date_et
        )
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM fresh)::int   AS cells,
           (SELECT count(*) FROM written)::int AS written,
           (SELECT count(*) FROM deleted)::int AS deleted
  `)) as unknown as { cells: number; written: number; deleted: number }[];

  return {
    cells: Number(rows[0]?.cells ?? 0),
    written: Number(rows[0]?.written ?? 0),
    deleted: Number(rows[0]?.deleted ?? 0),
    durationMs: Date.now() - started,
  };
}

/**
 * The report read: stored cells summed to the live query's (stage, phone) grain
 * over an ET day range. Same row type as queryDeliveryByStage, so every rollup
 * above it (provider / campaign / stage) is unchanged.
 */
export async function readDeliveryRollup(
  dbc: DbOrTx,
  orgId: string,
  range: EtDayRange,
): Promise<DeliveryStageRow[]> {
  const rows = (await dbc.execute(sql`
    SELECT stage_id, provider_phone_id,
           sum(sent)::int        AS sent,
           sum(delivered)::int   AS delivered,
           sum(undelivered)::int AS undelivered,
           sum(no_receipt)::int  AS no_receipt
    FROM stage_delivery_rollup
    WHERE org_id = ${orgId}::uuid
      AND sent_date_et BETWEEN ${range.from}::date AND ${range.to}::date
    GROUP BY 1, 2
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    stage_id: Number(r.stage_id),
    provider_phone_id: r.provider_phone_id == null ? null : Number(r.provider_phone_id),
    sent: Number(r.sent),
    delivered: Number(r.delivered),
    undelivered: Number(r.undelivered),
    no_receipt: Number(r.no_receipt),
  }));
}

/**
 * THE REPORT READ (cutover, 2026-09-2x). /reports/delivery and the Overview's
 * Delivered % column read the rollup through this; the live
 * queryDeliveryByStage stays for the undelivered tripwire (rolling hours,
 * matured sends — a day-grain rollup cannot express either) and for the
 * nightly reconciliation that checks this table against it.
 */
export async function getDeliveryByStage(orgId: string, range: EtDayRange): Promise<DeliveryStageRow[]> {
  return readDeliveryRollup(db, orgId, range);
}

/** A tier-A heartbeat older than this means the 10-minute refresh has missed ~3 runs. */
// ── Per-stage SENT counts: rollup for closed ET days, live for today ───────
//
// The Overview's Total Sent used to be one `count(*) … GROUP BY stage_id` over
// stage_sends. Measured on prod 2026-09-24, that single statement read
// **1.6-1.7 GB and ran 10-12 s** on a 92-day window — the dominant cost of both
// /api/keitaro/reports and /api/reports/performance.
//
// Every closed ET day is already counted in stage_delivery_rollup.sent, from
// the SAME definition (status='sent', bucketed by sent_at in ET). So this reads
// closed days from the rollup and counts ONLY TODAY live.
//
// ⚠️ TODAY IS DELIBERATELY LIVE, AND THE LAG IS THE REASON. Total Sent is the
// number an operator watches mid-send to confirm a campaign is actually going
// out; a 10-minute rollup lag there would read as a stall and get escalated.
// That is also why Total Sent carries NO "as of" label, unlike Delivered %.
//
// ⚠️ THE WINDOW IS ET-DAY ALIGNED BY CONSTRUCTION, which is what makes a
// day-grain rollup exact rather than approximate: getStageMetricsInRange takes
// `from`/`to` as ET DATE STRINGS and derives both bounds with fromZonedTime on
// midnight. There is no caller that can pass a partial day. If that ever
// changes, this function is wrong and the live count must come back.
/** The pool, or a transaction — so the boundary test can stage fixtures that
 *  are never committed. */
export type DeliveryDbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface SentCountScope {
  orgId: string;
  stageIds: number[];
  /** Inclusive ET day, as YYYY-MM-DD — the same string the caller was given. */
  fromEtDay: string;
  /** Inclusive ET day. */
  toEtDay: string;
  /** Exclusive UTC end of the window, for the live half. */
  toExclusiveUtc: Date;
}

export async function sentCountsByStage(
  dbc: DeliveryDbOrTx,
  scope: SentCountScope,
  now = new Date(),
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (scope.stageIds.length === 0) return out;

  const todayEt = formatInCampaignTimezone(now, "yyyy-MM-dd");
  const add = (stageId: number, n: number) =>
    out.set(stageId, (out.get(stageId) ?? 0) + n);

  // ── closed ET days: the rollup ──
  // Capped at yesterday: today is never read from the rollup, whatever the
  // requested window says.
  const rollupTo = scope.toEtDay < todayEt ? scope.toEtDay : addEtDays(todayEt, -1);
  if (scope.fromEtDay <= rollupTo) {
    const rows = (await dbc.execute(sql`
      SELECT stage_id, sum(sent)::int AS sent
      FROM stage_delivery_rollup
      WHERE org_id = ${scope.orgId}::uuid
        AND stage_id = ANY(${sql`ARRAY[${sql.join(
          scope.stageIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::int[]`})
        AND sent_date_et >= ${scope.fromEtDay}::date
        AND sent_date_et <= ${rollupTo}::date
      GROUP BY stage_id
    `)) as unknown as { stage_id: number; sent: number }[];
    for (const r of rows) add(Number(r.stage_id), Number(r.sent));
  }

  // ── today (ET): live ──
  // Only when the window actually reaches today. The lower bound is today's ET
  // midnight, so a row cannot be counted by both halves.
  if (scope.toEtDay >= todayEt) {
    const todayStartUtc = etDayBounds({ from: todayEt, to: todayEt }).fromUtc;
    if (todayStartUtc < scope.toExclusiveUtc) {
      const rows = (await dbc.execute(sql`
        SELECT stage_id, count(*)::int AS sent
        FROM stage_sends
        WHERE org_id = ${scope.orgId}::uuid
          AND status = 'sent'
          AND stage_id = ANY(${sql`ARRAY[${sql.join(
            scope.stageIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::int[]`})
          AND sent_at >= ${todayStartUtc.toISOString()}::timestamptz
          AND sent_at < ${scope.toExclusiveUtc.toISOString()}::timestamptz
        GROUP BY stage_id
      `)) as unknown as { stage_id: number; sent: number }[];
      for (const r of rows) add(Number(r.stage_id), Number(r.sent));
    }
  }

  return out;
}

export const FRESH_STALE_MINUTES = 30;
/** Matches HEARTBEAT_JOBS.deliveryRollupSettle.max_age_hours (~2 missed settles). */
export const SETTLE_STALE_HOURS = 7;

export interface DeliveryFreshness {
  /**
   * The OLDEST refresh any cell in the window may be behind — the honest "as
   * of". null when every cell is final, or when a tier the window depends on
   * has never run.
   */
  as_of: string | null;
  /** Every cell in the window is past the 7-day horizon: these numbers will not change. */
  final: boolean;
  /** A refresh tier this window depends on has missed its schedule (or never ran). */
  stale: boolean;
}

/**
 * Which refresh stamps a window depends on. Pure, so the rules are testable:
 *   · a window entirely older than the settle horizon is FINAL — no stamp matters;
 *   · a window touching today/yesterday depends on the 10-minute refresh;
 *   · a window touching days 2–6 back depends on the 3-hourly settle.
 * as_of is the older of the stamps it depends on, because some of its cells may
 * be that far behind.
 */
export function deliveryFreshness(
  range: EtDayRange,
  freshAt: Date | null,
  settleAt: Date | null,
  now: Date,
): DeliveryFreshness {
  const today = formatInCampaignTimezone(now, "yyyy-MM-dd");
  const freshFrom = addEtDays(today, -(FRESH_DAYS - 1));
  const settleFrom = addEtDays(today, -(SETTLE_DAYS - 1));
  if (range.to < settleFrom) return { as_of: null, final: true, stale: false };

  const deps: { at: Date | null; maxMs: number }[] = [];
  if (range.to >= freshFrom) deps.push({ at: freshAt, maxMs: FRESH_STALE_MINUTES * 60_000 });
  if (range.from < freshFrom) deps.push({ at: settleAt, maxMs: SETTLE_STALE_HOURS * 3_600_000 });

  const stale = deps.some((d) => d.at == null || now.getTime() - d.at.getTime() > d.maxMs);
  const known = deps.map((d) => d.at).filter((d): d is Date => d != null);
  const as_of =
    known.length === deps.length && known.length > 0
      ? new Date(Math.min(...known.map((d) => d.getTime()))).toISOString()
      : null;
  return { as_of, final: false, stale };
}

/** Freshness of a report window, from the two refresh heartbeats in cron_locks. */
export async function getDeliveryFreshness(range: EtDayRange, now = new Date()): Promise<DeliveryFreshness> {
  const rows = (await db.execute(sql`
    SELECT job_name, (extract(epoch FROM watermark) * 1000)::float8 AS ms FROM cron_locks
    WHERE job_name IN (${DELIVERY_ROLLUP_JOB}, ${DELIVERY_ROLLUP_SETTLE_JOB})
  `)) as unknown as { job_name: string; ms: number | null }[];
  const at = (job: string) => {
    const v = rows.find((r) => r.job_name === job)?.ms;
    return v == null ? null : new Date(Number(v));
  };
  return deliveryFreshness(range, at(DELIVERY_ROLLUP_JOB), at(DELIVERY_ROLLUP_SETTLE_JOB), now);
}

/** Canonical form for diffing two row sets — sorted by (stage, phone). */
export function canonicalDeliveryRows(rows: DeliveryStageRow[]): string {
  return JSON.stringify(
    [...rows].sort(
      (a, b) => a.stage_id - b.stage_id || (a.provider_phone_id ?? -1) - (b.provider_phone_id ?? -1),
    ),
  );
}

/** Rows present in one set and missing or different in the other, keyed stage|phone. */
export function diffDeliveryRows(
  stored: DeliveryStageRow[],
  live: DeliveryStageRow[],
): { key: string; stored: DeliveryStageRow | null; live: DeliveryStageRow | null }[] {
  const k = (r: DeliveryStageRow) => `${r.stage_id}|${r.provider_phone_id ?? "null"}`;
  const a = new Map(stored.map((r) => [k(r), r]));
  const b = new Map(live.map((r) => [k(r), r]));
  const out: { key: string; stored: DeliveryStageRow | null; live: DeliveryStageRow | null }[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key) ?? null;
    const y = b.get(key) ?? null;
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ key, stored: x, live: y });
  }
  return out;
}
