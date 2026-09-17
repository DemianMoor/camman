import { sql, type SQL } from "drizzle-orm";

import type { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import { mirrorStageCountersFromResults } from "@/lib/keitaro/poll";

// THE STAGE-DAY CONVERSION PROJECTION.
//
// keitaro_stage_results holds two kinds of column on one row: CLICK columns,
// dated by the click day and written by the aggregate poll, and CONVERSION
// columns, dated by the conversion day and written HERE, from the
// conversion_events ledger (migration 0181).
//
// ⚠️ WHY THIS EXISTS (bug 2, recon 2026-09-17). The poll used to fold
// conversions/log rows straight into the upsert, dated by Keitaro's `datetime`.
// Keitaro MOVES that datetime when a conversion is re-posted, and the poll's
// 3-day window left the old day's row frozen — so one conversion counted on two
// days (measured: stage 143_123_091126_2_s2_c661, 3 sales / $300 against
// Keitaro's true 2 / $200). The ledger's `occurred_at` is the ORIGINAL conversion time
// and never moves, so re-deriving a stage's days from the ledger makes the double
// count structurally impossible: the row is recomputed, and a day the ledger no
// longer explains is zeroed.
//
// ⚠️ NEVER RUN THIS WHEN THE INGEST FAILED. It is a full re-derivation of its
// scope, so a ledger that is missing rows would zero real revenue. The caller
// (app/api/keitaro/poll/route.ts) runs it only after an `ok` ingest window.
//
// No `"server-only"`: scripts/resync-stage-day-conversions.ts and
// scripts/test-stage-day-conversions.ts import it directly (same convention as
// lib/reporting/offer-group-report.ts). It holds no secrets.
//
// docs/04-features/keitaro-poll.md · docs/04-features/conversion-events.md

export type Database = typeof db;
export type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

// How far back to look for ledger rows that CHANGED, when the caller doesn't
// name a stage set. Stateless fixed lookback, not a stored cursor — the same
// choice (and reason) as the counted-clicker incremental pass: there is no
// high-water mark for data to get stranded behind. 30 min covers six missed
// */5 ticks. Served by conversion_events_updated_at_idx (migration 0182).
export const LEDGER_CHANGE_LOOKBACK_MINUTES = 30;

// TODAY'S SEMANTICS, DELIBERATELY (Phase 3 task 3). The aggregate poll counted
// every conversions/log row it fetched as a Sale — the fetch filtered to the
// lead/sale/rejected statuses that make up Keitaro's `conversions` metric — and
// a `lead` row also as a Checkout (Keitaro's `leads`). Reproduced here on the
// ledger's canonical `keitaro_type` so the ONLY delta from this task is the
// −$100 double count. Task 6 replaces SALES_FILTER/REVENUE_FILTER with the
// shared purchase / approved-revenue predicates.
const SALES_FILTER: SQL = sql`ce.keitaro_type IN ('lead', 'sale', 'rejected')`;
const CHECKOUT_FILTER: SQL = sql`ce.keitaro_type = 'lead'`;
const REVENUE_FILTER: SQL = sql`ce.keitaro_type IN ('lead', 'sale', 'rejected')`;

export interface StageDayConversionSync {
  stagesInScope: number;
  /** (stage, day) rows inserted or updated with ledger-derived values. */
  rowsWritten: number;
  /** Existing rows whose conversion columns the ledger no longer explains. */
  rowsZeroed: number;
}

/**
 * Stage ids whose ledger rows were inserted or updated within the lookback.
 * `occurred_at` never moves, so a re-posted OLD conversion can only be found by
 * `updated_at`. Cross-org, like the poll itself.
 */
export async function changedLedgerStageIds(
  dbc: DbOrTx,
  sinceMinutes: number = LEDGER_CHANGE_LOOKBACK_MINUTES,
): Promise<number[]> {
  const rows = (await dbc.execute(sql`
    SELECT DISTINCT ce.stage_id
    FROM conversion_events ce
    WHERE ce.updated_at >= now() - make_interval(mins => ${sinceMinutes}::int)
      AND ce.stage_id IS NOT NULL
  `)) as unknown as { stage_id: number }[];
  return rows.map((r) => Number(r.stage_id));
}

/**
 * Re-derive the conversion columns of every (stage, ET day) in scope from the
 * ledger, zero the days the ledger no longer explains, then mirror the stage
 * counters that hang off them. `stageIds` omitted = every stage (the one-shot
 * resync); `stageIds: []` = a no-op.
 */
export async function syncStageDayConversions(
  dbc: DbOrTx,
  opts: { stageIds?: number[] },
): Promise<StageDayConversionSync> {
  const ids = opts.stageIds;
  if (ids && ids.length === 0) {
    return { stagesInScope: 0, rowsWritten: 0, rowsZeroed: 0 };
  }
  // sql.join over per-id fragments — never interpolate the array itself.
  const scope: SQL = ids
    ? sql`IN (${sql.join(
        ids.map((id) => sql`${id}::int`),
        sql`, `,
      )})`
    : sql`IS NOT NULL`;

  const written = (await dbc.execute(sql`
    WITH ledger AS (
      SELECT ce.org_id,
             ce.stage_id,
             (ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date AS stat_date,
             count(*) FILTER (WHERE ${SALES_FILTER})::int AS sales,
             count(*) FILTER (WHERE ${CHECKOUT_FILTER})::int AS checkouts,
             coalesce(sum(ce.revenue) FILTER (WHERE ${REVENUE_FILTER}), 0)::numeric(12, 4) AS revenue
      FROM conversion_events ce
      WHERE ce.stage_id ${scope}
      GROUP BY 1, 2, 3
    )
    INSERT INTO keitaro_stage_results
      (org_id, campaign_id, stage_id, stage_tracking_id, stat_date,
       checkouts, sales, revenue, payout_at_conversion)
    SELECT l.org_id, cs.campaign_id, l.stage_id, coalesce(cs.tracking_id, ''), l.stat_date,
           l.checkouts, l.sales, l.revenue,
           CASE WHEN l.sales > 0 THEN (l.revenue / l.sales)::numeric(12, 4) ELSE NULL END
    FROM ledger l
    JOIN campaign_stages cs ON cs.id = l.stage_id
    ON CONFLICT (org_id, stage_id, stat_date) DO UPDATE SET
      checkouts            = EXCLUDED.checkouts,
      sales                = EXCLUDED.sales,
      revenue              = EXCLUDED.revenue,
      payout_at_conversion = EXCLUDED.payout_at_conversion,
      synced_at            = now()
    WHERE keitaro_stage_results.checkouts IS DISTINCT FROM EXCLUDED.checkouts
       OR keitaro_stage_results.sales     IS DISTINCT FROM EXCLUDED.sales
       OR keitaro_stage_results.revenue   IS DISTINCT FROM EXCLUDED.revenue
    RETURNING keitaro_stage_results.id AS id
  `)) as unknown as { id: number }[];

  // A day the ledger no longer explains. Only the CONVERSION columns are reset —
  // the click columns on the same row are the aggregate poll's, and a stage-day
  // with clicks and no conversions is normal.
  const zeroed = (await dbc.execute(sql`
    UPDATE keitaro_stage_results k
    SET checkouts = 0, sales = 0, revenue = 0, payout_at_conversion = NULL, synced_at = now()
    WHERE k.stage_id ${scope}
      AND (k.checkouts <> 0 OR k.sales <> 0 OR k.revenue <> 0)
      AND NOT EXISTS (
        SELECT 1 FROM conversion_events ce
        WHERE ce.stage_id = k.stage_id
          AND (ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date = k.stat_date
          AND (${SALES_FILTER} OR ${REVENUE_FILTER})
      )
    RETURNING k.id AS id
  `)) as unknown as { id: number }[];

  const touched = (await dbc.execute(sql`
    SELECT DISTINCT k.stage_id FROM keitaro_stage_results k WHERE k.stage_id ${scope}
  `)) as unknown as { stage_id: number }[];
  const stageIds = touched.map((r) => Number(r.stage_id));
  if (stageIds.length > 0) {
    // Checkout Clicks on the stage is a mirror of `checkouts`, so it has to be
    // re-mirrored AFTER the conversion columns move, or it lags a whole tick.
    await mirrorStageCountersFromResults(dbc as Database, stageIds);
  }

  return { stagesInScope: stageIds.length, rowsWritten: written.length, rowsZeroed: zeroed.length };
}
