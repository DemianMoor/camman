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
// ⚠️ ZEROING IS BOUNDED BY THE LEDGER'S OWN COVERAGE (review fix C1). A full
// re-derivation is only safe where the ledger actually knows something. Two
// bounds, both enforced in SQL below:
//   1. EMPTY-LEDGER REFUSAL — no stage-attributed ledger row anywhere ⇒ do
//      nothing and report `refused: "empty_ledger"`. Same refusal
//      scripts/resync-stage-day-conversions.ts already carried, moved into the
//      function so the */5 route can't outrun it.
//   2. PER-STAGE COVERAGE FLOOR — a stage-day is only zeroable when the ledger
//      holds a conversion for THAT STAGE on or before that day. A stage with no
//      ledger rows at all is therefore never zeroed, and no stage-day older than
//      that stage's earliest ledger conversion is either.
// Per-stage, not one global floor: the live ingest window is 7 ET days, so on a
// ledger that has not been fully backfilled a global floor would still zero
// months of real sales/revenue for every stage with a recent click. The floor is
// computed over ALL stage-attributed rows, not just the ones the SALES/REVENUE
// filters count — coverage means "the ingest reached this day for this stage", so
// a registration-only day IS covered and a stale sale on it is genuinely
// unexplained.
//
// ⚠️ NEVER RUN THIS WHEN THE INGEST FAILED. Even with the bounds above, a
// truncated or partially-fetched window makes real conversions look unexplained
// INSIDE the covered range. The caller (app/api/keitaro/poll/route.ts) runs it
// only after an `ok` ingest window.
//
// No `"server-only"`: scripts/resync-stage-day-conversions.ts and
// scripts/test-stage-day-conversions.ts import it directly (same convention as
// lib/reporting/offer-group-report.ts). It holds no secrets.
//
// docs/04-features/keitaro-poll.md · docs/04-features/conversion-events.md

export type Database = typeof db;
export type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

// How far back to look for ledger rows that CHANGED, when the caller doesn't
// name a stage set. 30 min covers six missed */5 ticks. Served by
// conversion_events_updated_at_idx (migration 0182).
export const LEDGER_CHANGE_LOOKBACK_MINUTES = 30;

// Stage ids one discovery may return. Each id is a bind parameter in three
// statements below, so an unbounded change set (a backfill re-touching the whole
// ledger) would blow Postgres's 65535-parameter ceiling and fail the tick.
export const MAX_CHANGED_STAGE_IDS = 2000;

// Stage ids per counter-mirror statement — same reason, and the resync's
// unscoped run names every stage in the org.
const MIRROR_CHUNK = 1000;

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
  /** The scope this run was GIVEN — `"all"` for the unscoped resync. */
  stagesInScope: number | "all";
  /** (stage, day) rows inserted or updated with ledger-derived values. */
  rowsWritten: number;
  /** Existing rows whose conversion columns the ledger no longer explains. */
  rowsZeroed: number;
  /**
   * Earliest ET day the ledger covers across this run's scope (null when the
   * scope has no stage-attributed ledger rows). Nothing older than this was
   * zeroed anywhere; the bound actually applied is per stage.
   */
  coverageFloor: string | null;
  /** Set when the run wrote nothing on purpose. */
  refused: "empty_ledger" | null;
}

/**
 * Re-derive the conversion columns of every (stage, ET day) in scope from the
 * ledger, zero the covered days the ledger no longer explains, then mirror the
 * stage counters that hang off them. `stageIds` omitted = every stage (the
 * one-shot resync); `stageIds: []` = a no-op.
 */
export async function syncStageDayConversions(
  dbc: DbOrTx,
  opts: { stageIds?: number[] },
): Promise<StageDayConversionSync> {
  const ids = opts.stageIds;
  const stagesInScope: number | "all" = ids ? ids.length : "all";
  const nothing = { rowsWritten: 0, rowsZeroed: 0, coverageFloor: null, refused: null } as const;
  if (ids && ids.length === 0) {
    return { stagesInScope, ...nothing };
  }
  // sql.join over per-id fragments — never interpolate the array itself.
  const scope: SQL = ids
    ? sql`IN (${sql.join(
        ids.map((id) => sql`${id}::int`),
        sql`, `,
      )})`
    : sql`IS NOT NULL`;

  // COVERAGE, before any write. The EXISTS is the empty-ledger refusal (global:
  // an empty ledger means the Phase 1 backfill has not run, whatever the scope).
  // coverage_floor is over the SCOPE and is reported, not enforced — the enforced
  // bound is the per-stage floor joined into the zeroing UPDATE below.
  const [coverage] = (await dbc.execute(sql`
    SELECT EXISTS (SELECT 1 FROM conversion_events WHERE stage_id IS NOT NULL) AS ledger_has_rows,
           (SELECT min((ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date)::text
              FROM conversion_events ce WHERE ce.stage_id ${scope}) AS coverage_floor
  `)) as unknown as { ledger_has_rows: boolean; coverage_floor: string | null }[];
  if (!coverage.ledger_has_rows) {
    return { stagesInScope, ...nothing, refused: "empty_ledger" };
  }
  const coverageFloor = coverage.coverage_floor;

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
       -- payout is derived from the two above, so it only differs on its own when
       -- a row predates the column or was written NULL by an older path. Without
       -- this the stale/NULL payout can never be repaired.
       OR keitaro_stage_results.payout_at_conversion IS DISTINCT FROM EXCLUDED.payout_at_conversion
    RETURNING keitaro_stage_results.id AS id
  `)) as unknown as { id: number }[];

  // A COVERED day the ledger no longer explains. Only the CONVERSION columns are
  // reset — the click columns on the same row are the aggregate poll's, and a
  // stage-day with clicks and no conversions is normal. `pending_revenue`
  // (migration 0182) is reset with them: Task 6 starts writing it from the same
  // ledger read, and a column that is projected but never zeroed is exactly the
  // stale-higher-value bug this fix is about.
  //
  // The join to `cov` is the C1 bound: a stage absent from it (no ledger rows
  // at all) has NO row to zero, and `k.stat_date >= cov.floor_date` keeps
  // everything before that stage's earliest ledger conversion untouched.
  const zeroed = (await dbc.execute(sql`
    UPDATE keitaro_stage_results k
    SET checkouts = 0, sales = 0, revenue = 0, pending_revenue = 0,
        payout_at_conversion = NULL, synced_at = now()
    FROM (
      SELECT ce.stage_id,
             min((ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date) AS floor_date
      FROM conversion_events ce
      WHERE ce.stage_id ${scope}
      GROUP BY 1
    ) cov
    WHERE k.stage_id ${scope}
      AND k.stage_id = cov.stage_id
      AND k.stat_date >= cov.floor_date
      AND (k.checkouts <> 0 OR k.sales <> 0 OR k.revenue <> 0 OR k.pending_revenue <> 0)
      AND NOT EXISTS (
        SELECT 1 FROM conversion_events ce
        WHERE ce.stage_id = k.stage_id
          AND (ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date = k.stat_date
          AND (${SALES_FILTER} OR ${REVENUE_FILTER})
      )
    RETURNING k.id AS id
  `)) as unknown as { id: number }[];

  // Checkout Clicks on the stage is a mirror of `checkouts`, so it has to be
  // re-mirrored AFTER the conversion columns move, or it lags a whole tick.
  // EXACT mode: the projection is non-monotonic, so a zeroed day must be able to
  // pull the counter DOWN (review fix I2).
  const mirrorIds = ids ?? (await stageIdsWithRows(dbc));
  for (let i = 0; i < mirrorIds.length; i += MIRROR_CHUNK) {
    await mirrorStageCountersFromResults(dbc as Database, mirrorIds.slice(i, i + MIRROR_CHUNK), {
      exactCheckoutClicks: true,
    });
  }

  return {
    stagesInScope,
    rowsWritten: written.length,
    rowsZeroed: zeroed.length,
    coverageFloor,
    refused: null,
  };
}

/** Every stage with a keitaro_stage_results row — the unscoped run's mirror list. */
async function stageIdsWithRows(dbc: DbOrTx): Promise<number[]> {
  const rows = (await dbc.execute(sql`
    SELECT DISTINCT k.stage_id FROM keitaro_stage_results k WHERE k.stage_id IS NOT NULL
  `)) as unknown as { stage_id: number }[];
  return rows.map((r) => Number(r.stage_id));
}

/**
 * Stage ids whose ledger rows were inserted or updated within the lookback.
 * `occurred_at` never moves, so a re-posted OLD conversion can only be found by
 * `updated_at`. Cross-org, like the poll itself. Capped at
 * MAX_CHANGED_STAGE_IDS, oldest change first; `truncated` says the rest were
 * dropped for this run.
 */
export async function changedLedgerStageIds(
  dbc: DbOrTx,
  sinceMinutes: number = LEDGER_CHANGE_LOOKBACK_MINUTES,
  limit: number = MAX_CHANGED_STAGE_IDS,
): Promise<{ stageIds: number[]; truncated: boolean }> {
  const rows = (await dbc.execute(sql`
    SELECT ce.stage_id, max(ce.updated_at) AS last_changed
    FROM conversion_events ce
    WHERE ce.updated_at >= now() - make_interval(mins => ${sinceMinutes}::int)
      AND ce.stage_id IS NOT NULL
    GROUP BY 1
    ORDER BY max(ce.updated_at), ce.stage_id
    LIMIT ${limit + 1}::int
  `)) as unknown as { stage_id: number }[];
  const truncated = rows.length > limit;
  return {
    stageIds: (truncated ? rows.slice(0, limit) : rows).map((r) => Number(r.stage_id)),
    truncated,
  };
}
