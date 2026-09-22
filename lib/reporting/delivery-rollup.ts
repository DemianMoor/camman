import { sql } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";

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

/** Tier A: today + yesterday (ET), every run. */
export const FRESH_DAYS = 2;
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
  const settle =
    lastSettle == null || now.getTime() - lastSettle.getTime() >= SETTLE_EVERY_HOURS * 3_600_000;
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
