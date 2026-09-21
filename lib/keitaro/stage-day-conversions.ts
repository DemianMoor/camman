import { sql, type SQL } from "drizzle-orm";

import type { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import { mirrorStageCountersFromResults } from "@/lib/keitaro/poll";
import { approvedRevenueClause, pendingRevenueClause, purchasedClause } from "@/lib/sale-attribution";

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
// ⚠️ ZEROING AND REDUCING ARE BOUNDED BY THE LEDGER'S OWN COVERAGE (review fixes
// C1, A2). A full re-derivation is only safe where the ledger actually knows
// something. Three bounds, all enforced below:
//   1. EMPTY-LEDGER REFUSAL — no stage-attributed ledger row anywhere ⇒ do
//      nothing and report `refused: "empty_ledger"`. Same refusal
//      scripts/resync-stage-day-conversions.ts already carried, moved into the
//      function so the */5 route can't outrun it.
//   2. GLOBAL COVERAGE GUARD — keitaro_stage_results still REPORTS conversions
//      from a day the ledger does not reach back to ⇒ refuse the whole
//      projection, `refused: "ledger_behind_history"`. The zeroing bound (3) only
//      protects a day the ledger has no floor for; it cannot protect a day the
//      ledger covers PARTIALLY, where `ON CONFLICT DO UPDATE SET … = EXCLUDED`
//      would REDUCE a real total to the partial sum. An interrupted backfill, or
//      one old re-posted conversion dragging a single stage's floor back months,
//      is exactly that state — and it is the state prod is in today (no ledger at
//      all). So coverage is checked once per run, before any write, against the
//      earliest conversion day still reported anywhere in keitaro_stage_results.
//   3. PER-STAGE COVERAGE FLOOR — a stage-day is only zeroable when the ledger
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
// ⚠️ WHAT BOUND 2 DOES NOT COVER, DELIBERATELY. A coverage GAP *inside*
// [per-stage floor, now] — the ledger reaches back far enough but is missing rows
// in the middle — still reduces or zeroes the days in the hole. Nothing the
// projection can read distinguishes "no conversion happened that day" from "the
// ingest lost that day", so the guard against a gap is the backfill's own verify
// (scripts/verify-conversion-events.ts: every Keitaro conversion present), not
// this function. See docs/04-features/keitaro-poll.md.
//
// ⚠️ NEVER RUN THIS WHEN THE INGEST FAILED. Even with the bounds above, a
// truncated or partially-fetched window makes real conversions look unexplained
// INSIDE the covered range. The caller (app/api/keitaro/poll/route.ts) runs it
// only after an `ok` ingest window.
//
// RESUMABLE DISCOVERY (review fix I3). `occurred_at` never moves, so a re-posted
// OLD conversion is only findable by `updated_at`. That lookback used to be a
// fixed 30 minutes with no cursor, so ~6 consecutive failed ticks stranded
// changed stage-days forever. Discovery now carries a watermark in
// cron_locks.watermark under PROJECTION_JOB_NAME, advanced ONLY after a
// successful projection — see discoverChangedLedgerStages / runStageDayProjection.
//
// No `"server-only"`: scripts/resync-stage-day-conversions.ts and
// scripts/test-stage-day-conversions.ts import it directly (same convention as
// lib/reporting/offer-group-report.ts). It holds no secrets.
//
// docs/04-features/keitaro-poll.md · docs/04-features/conversion-events.md

export type Database = typeof db;
export type DbOrTx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

// The FLOOR of the discovery window, and the whole window on a first run (no
// stored watermark). 30 min covers six missed */5 ticks; past that the watermark
// extends the window back instead. Served by conversion_events_updated_at_idx
// (migration 0182).
export const LEDGER_CHANGE_LOOKBACK_MINUTES = 30;

// cron_locks row that carries the discovery watermark. NOT a lease — the poll
// route's own `keitaro-poll` lease is the single-runner guard; this row only
// stores the cursor, exactly like `propagate-clickers` does
// (lib/links/propagate-clickers.ts).
export const PROJECTION_JOB_NAME = "conversion-stage-day-projection";

// Re-read this much either side of the watermark. Covers commit skew: a row
// whose updated_at was assigned before the previous window's end but which
// committed after it would otherwise never be seen again.
export const PROJECTION_WATERMARK_OVERLAP_MINUTES = 5;

// Stage ids one discovery may return. Each id is a bind parameter in the
// statements below — the zeroing UPDATE binds every id TWICE — so an unbounded
// change set (a backfill re-touching the whole ledger) would blow Postgres's
// 65535-parameter ceiling and fail the tick. 20000 ⇒ 40000 params in the worst
// statement, and comfortably more stages than this dataset holds in total, so
// only a full-ledger re-touch can reach it.
//
// ⚠️ THE CAP CANNOT CLAIM PARTIAL PROGRESS (review fix A5). The earlier version
// ordered oldest-first and advanced the watermark to the last id it KEPT, which
// only works if the kept ids reach a LATER `max(updated_at)` than the window
// start. When more stages share one `max(updated_at)` than the cap allows — a
// backfill's single-statement re-touch is exactly that: every stage carries the
// same timestamp — the resume point equals the window start, the tick claims
// progress it did not make, and the remainder is never projected. So a truncated
// discovery now HOLDS the watermark and pages instead: see runStageDayProjection.
export const MAX_CHANGED_STAGE_IDS = 20000;

// Stage ids per counter-mirror statement — same reason, and the resync's
// unscoped run names every stage in the org. Each id binds three parameters
// there (the IN list, plus its row in the prior-checkout-sum VALUES list).
const MIRROR_CHUNK = 1000;

// THE SHARED DEFINITIONS (lib/sale-attribution.ts). Sales = counted PURCHASE
// events (pending or approved; a rejected conversion is a refund, not a sale —
// which the old aggregate poll got wrong, counting every fetched row including
// rejected). Revenue = `counts_revenue` events in status `approved` only, with
// `pending` in its own column so a held payout is visible but never summed into
// Revenue / EPC / ROI / profit (user decision 3).
//
// Checkouts stays Keitaro's `leads` metric — the count of `lead`-TYPE
// conversions — unchanged, because campaign_stages.checkout_click_count mirrors
// it and its meaning is "reached checkout", not "purchased". Phase 5's per-event
// columns supersede it.
const SALES_FILTER: SQL = purchasedClause();
const CHECKOUT_FILTER: SQL = sql`ce.keitaro_type = 'lead'`;
const REVENUE_FILTER: SQL = approvedRevenueClause();
const PENDING_REVENUE_FILTER: SQL = pendingRevenueClause();

/**
 * Why a run wrote nothing on purpose.
 *   `empty_ledger`         — no stage-attributed ledger row anywhere.
 *   `ledger_behind_history`— keitaro_stage_results reports a conversion day older
 *                            than the ledger's earliest, so a re-derivation would
 *                            reduce real totals to partial sums.
 */
export type ProjectionRefusal = "empty_ledger" | "ledger_behind_history" | null;

export interface ProjectionCoverage {
  /** Any stage-attributed ledger row at all (global, whatever the scope). */
  ledgerHasRows: boolean;
  /** Earliest stage-attributed ledger ET day, GLOBAL — the guard's coverage side. */
  ledgerFloor: string | null;
  /**
   * Earliest ET day keitaro_stage_results still reports a non-zero conversion
   * column on that the ledger does NOT reach — i.e. `min(stat_date)` over the
   * reported-conversion rows older than `ledgerFloor`. Null when the ledger
   * reaches the whole reported history (the healthy state). Non-null ⇒ it is
   * also the earliest reported conversion day overall, since any row at or after
   * the floor is later than one before it.
   */
  reportedHistoryFloor: string | null;
  /**
   * Earliest ET day the ledger covers across this run's SCOPE (null when the
   * scope has no stage-attributed ledger rows). Reported, not enforced: nothing
   * older than this was zeroed anywhere, but the bound actually applied is per
   * stage.
   */
  coverageFloor: string | null;
  /** Non-null ⇒ the caller must not write or zero anything. */
  refused: ProjectionRefusal;
}

export interface StageDayConversionSync extends ProjectionCoverage {
  /** The scope this run was GIVEN — `"all"` for the unscoped resync. */
  stagesInScope: number | "all";
  /** (stage, day) rows inserted or updated with ledger-derived values. */
  rowsWritten: number;
  /** Existing rows whose conversion columns the ledger no longer explains. */
  rowsZeroed: number;
}

/**
 * The two coverage bounds that gate every write, read in ONE statement so the
 * projection and the resync's pre-flight cannot drift apart (review fix A2).
 * `stageIds` only narrows the REPORTED `coverageFloor`; both refusals are global,
 * because a partially-backfilled ledger is a whole-table condition and a scoped
 * run would otherwise happily reduce the stages it happens to name.
 */
export async function readProjectionCoverage(
  dbc: DbOrTx,
  opts: { stageIds?: number[] } = {},
): Promise<ProjectionCoverage> {
  const ids = opts.stageIds;
  // An empty scope covers nothing, and `IN ()` is a syntax error: `IS NULL` is
  // the honest fragment (no stage-attributed row matches it).
  const scope: SQL = !ids
    ? sql`IS NOT NULL`
    : ids.length === 0
      ? sql`IS NULL`
      : sql`IN (${sql.join(
          ids.map((id) => sql`${id}::int`),
          sql`, `,
        )})`;
  // `reported_history_floor` is deliberately written as a `stat_date <
  // ledger_floor` probe rather than a bare `min(stat_date)` over the non-zero
  // rows: the healthy case matches no rows and the range is served by
  // keitaro_stage_results_campaign_date_idx, so the guard costs an index probe
  // per run instead of a full scan of the largest table on the tick.
  const [row] = (await dbc.execute(sql`
    WITH cov AS (
      SELECT EXISTS (SELECT 1 FROM conversion_events WHERE stage_id IS NOT NULL) AS ledger_has_rows,
             (SELECT min((ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date)
                FROM conversion_events ce WHERE ce.stage_id IS NOT NULL) AS ledger_floor,
             (SELECT min((ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date)
                FROM conversion_events ce WHERE ce.stage_id ${scope}) AS coverage_floor
    )
    SELECT cov.ledger_has_rows,
           cov.ledger_floor::text AS ledger_floor,
           cov.coverage_floor::text AS coverage_floor,
           (SELECT min(k.stat_date)::text
              FROM keitaro_stage_results k
             WHERE k.stat_date < cov.ledger_floor
               AND (k.checkouts <> 0 OR k.sales <> 0 OR k.revenue <> 0 OR k.pending_revenue <> 0)
           ) AS reported_history_floor
    FROM cov
  `)) as unknown as {
    ledger_has_rows: boolean;
    ledger_floor: string | null;
    coverage_floor: string | null;
    reported_history_floor: string | null;
  }[];
  const coverage = {
    ledgerHasRows: row.ledger_has_rows,
    ledgerFloor: row.ledger_floor,
    coverageFloor: row.coverage_floor,
    reportedHistoryFloor: row.reported_history_floor,
  };
  if (!coverage.ledgerHasRows) {
    // coverageFloor / ledgerFloor are necessarily null here — nothing to report.
    return { ...coverage, refused: "empty_ledger" };
  }
  if (coverage.reportedHistoryFloor !== null) {
    return { ...coverage, refused: "ledger_behind_history" };
  }
  return { ...coverage, refused: null };
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
  const nothing = { rowsWritten: 0, rowsZeroed: 0 } as const;
  if (ids && ids.length === 0) {
    // A no-op BEFORE any read, so the coverage fields are unconsulted rather
    // than measured: nothing can be written, so nothing needs a bound.
    return {
      stagesInScope,
      ...nothing,
      ledgerHasRows: false,
      ledgerFloor: null,
      reportedHistoryFloor: null,
      coverageFloor: null,
      refused: null,
    };
  }
  // sql.join over per-id fragments — never interpolate the array itself.
  const scope: SQL = ids
    ? sql`IN (${sql.join(
        ids.map((id) => sql`${id}::int`),
        sql`, `,
      )})`
    : sql`IS NOT NULL`;

  // COVERAGE, ONCE, BEFORE ANY WRITE. Both refusals are global; `coverageFloor`
  // is over the SCOPE and is reported, not enforced — the enforced per-day bound
  // is the per-stage floor joined into the zeroing UPDATE below.
  const coverage = await readProjectionCoverage(dbc, { stageIds: ids });
  if (coverage.refused !== null) {
    return { stagesInScope, ...nothing, ...coverage };
  }

  // THE TRACKER'S CHECKOUT SUM PER STAGE, AS IT STANDS BEFORE THIS RUN WRITES —
  // the provenance input of the Checkout Clicks mirror below (see
  // mirrorStageCountersFromResults): a counter still equal to it is the
  // tracker's and follows the new sum exactly, 0 included; one that differs was
  // entered by hand and a tracker 0 never overwrites it. Same scope as the
  // mirror; a stage with no row yet (the unscoped run can create one) has no
  // entry, and the mirror reads that as 0.
  const priorCheckoutSums = new Map(
    (
      (await dbc.execute(sql`
        SELECT k.stage_id, coalesce(sum(k.checkouts), 0)::int AS checkouts
        FROM keitaro_stage_results k
        WHERE k.stage_id ${scope}
        GROUP BY k.stage_id
      `)) as unknown as { stage_id: number; checkouts: number }[]
    ).map((r) => [Number(r.stage_id), Number(r.checkouts)] as const),
  );

  const written = (await dbc.execute(sql`
    WITH ledger AS (
      SELECT ce.org_id,
             ce.stage_id,
             (ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date AS stat_date,
             count(*) FILTER (WHERE ${SALES_FILTER})::int AS sales,
             count(*) FILTER (WHERE ${CHECKOUT_FILTER})::int AS checkouts,
             coalesce(sum(ce.revenue) FILTER (WHERE ${REVENUE_FILTER}), 0)::numeric(12, 4) AS revenue,
             coalesce(sum(ce.revenue) FILTER (WHERE ${PENDING_REVENUE_FILTER}), 0)::numeric(12, 4) AS pending_revenue
      FROM conversion_events ce
      WHERE ce.stage_id ${scope}
      GROUP BY 1, 2, 3
    )
    INSERT INTO keitaro_stage_results
      (org_id, campaign_id, stage_id, stage_tracking_id, stat_date,
       checkouts, sales, revenue, pending_revenue, payout_at_conversion)
    SELECT l.org_id, cs.campaign_id, l.stage_id, coalesce(cs.tracking_id, ''), l.stat_date,
           l.checkouts, l.sales, l.revenue, l.pending_revenue,
           CASE WHEN l.sales > 0 THEN (l.revenue / l.sales)::numeric(12, 4) ELSE NULL END
    FROM ledger l
    -- BOTH keys (review fix A3). The row is written with the LEDGER's org_id, so
    -- joining on the stage id alone would let one bad ledger row create a
    -- keitaro_stage_results row under the wrong org — mirroring another org's
    -- stage counters into it. A mismatched row now joins to nothing and is
    -- skipped; the ingest's own org_mismatch alert is what reports it.
    JOIN campaign_stages cs ON cs.id = l.stage_id AND cs.org_id = l.org_id
    ON CONFLICT (org_id, stage_id, stat_date) DO UPDATE SET
      checkouts            = EXCLUDED.checkouts,
      sales                = EXCLUDED.sales,
      revenue              = EXCLUDED.revenue,
      pending_revenue      = EXCLUDED.pending_revenue,
      payout_at_conversion = EXCLUDED.payout_at_conversion,
      synced_at            = now()
    WHERE keitaro_stage_results.checkouts IS DISTINCT FROM EXCLUDED.checkouts
       OR keitaro_stage_results.sales     IS DISTINCT FROM EXCLUDED.sales
       OR keitaro_stage_results.revenue   IS DISTINCT FROM EXCLUDED.revenue
       OR keitaro_stage_results.pending_revenue IS DISTINCT FROM EXCLUDED.pending_revenue
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
  // ⚠️ "EXPLAINED" MUST NAME EVERY COLUMN THIS ZEROES — ALL FOUR (review fix,
  // 2026-09-18). Until Task 6, SALES_FILTER was `keitaro_type IN ('lead','sale',
  // 'rejected')`, a strict SUPERSET of CHECKOUT_FILTER, so `SALES ∨ REVENUE ∨
  // PENDING` implied the checkout side for free. Task 6 flipped SALES_FILTER to
  // the ledger's purchase predicate and broke that containment: a day whose only
  // ledger rows are lead-TYPE NON-purchases — a $0 registration posted as `lead`,
  // or an UNMAPPED row — had `checkouts` written by the INSERT above and zeroed
  // here in the SAME run, then rewritten and re-zeroed on every */5 tick forever,
  // dragging campaign_stages.checkout_click_count with it. The four filters are
  // now the exact set the INSERT writes from, so the UPDATE is the complement of
  // the INSERT and the projection is idempotent (test PB1–PB4).
  //
  // The join to `cov` is the C1 bound: a stage absent from it (no ledger rows
  // at all) has NO row to zero, and `k.stat_date >= cov.floor_date` keeps
  // everything before that stage's earliest ledger conversion untouched.
  const zeroed = (await dbc.execute(sql`
    UPDATE keitaro_stage_results k
    SET checkouts = 0, sales = 0, revenue = 0, pending_revenue = 0,
        payout_at_conversion = NULL, synced_at = now()
    FROM (
      SELECT ce.org_id, ce.stage_id,
             min((ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date) AS floor_date
      FROM conversion_events ce
      WHERE ce.stage_id ${scope}
      GROUP BY 1, 2
    ) cov
    WHERE k.stage_id ${scope}
      AND k.stage_id = cov.stage_id
      -- org too (review fix A3): the floor that authorises zeroing a row must come
      -- from the ledger of the row's OWN org, exactly like the write above.
      AND k.org_id = cov.org_id
      AND k.stat_date >= cov.floor_date
      AND (k.checkouts <> 0 OR k.sales <> 0 OR k.revenue <> 0 OR k.pending_revenue <> 0)
      AND NOT EXISTS (
        SELECT 1 FROM conversion_events ce
        WHERE ce.stage_id = k.stage_id
          AND ce.org_id = k.org_id
          AND (ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date = k.stat_date
          AND (${SALES_FILTER} OR ${CHECKOUT_FILTER} OR ${REVENUE_FILTER} OR ${PENDING_REVENUE_FILTER})
      )
    RETURNING k.id AS id
  `)) as unknown as { id: number }[];

  // Checkout Clicks on the stage is a mirror of `checkouts`, so it has to be
  // re-mirrored AFTER the conversion columns move, or it lags a whole tick.
  // The projection is non-monotonic, so a zeroed day must be able to pull a
  // TRACKER-OWNED counter down (review fix I2) — but only that one: a counter
  // that no longer equals the pre-run sum is hand-entered and keeps the guard
  // (prod 2026-09-21: exact mode on every in-scope stage zeroed stage 130's
  // hand-entered 22).
  const mirrorIds = ids ?? (await stageIdsWithRows(dbc));
  for (let i = 0; i < mirrorIds.length; i += MIRROR_CHUNK) {
    await mirrorStageCountersFromResults(dbc as Database, mirrorIds.slice(i, i + MIRROR_CHUNK), {
      priorCheckoutSums,
    });
  }

  return {
    stagesInScope,
    rowsWritten: written.length,
    rowsZeroed: zeroed.length,
    ...coverage,
  };
}

/** Every stage with a keitaro_stage_results row — the unscoped run's mirror list. */
async function stageIdsWithRows(dbc: DbOrTx): Promise<number[]> {
  const rows = (await dbc.execute(sql`
    SELECT DISTINCT k.stage_id FROM keitaro_stage_results k WHERE k.stage_id IS NOT NULL
  `)) as unknown as { stage_id: number }[];
  return rows.map((r) => Number(r.stage_id));
}

export interface ProjectionDiscovery {
  /** cron_locks.watermark before this run; null = never ran. */
  watermarkFrom: string | null;
  /** Lower bound of the `updated_at` window scanned. */
  windowFrom: string;
  /** Upper bound — the database's now() when discovery ran. */
  windowTo: string;
  /** Stage ids whose ledger rows changed in the window, at most `limit`. */
  stageIds: number[];
  /**
   * More stages changed in the window than the cap allowed. The kept ids ARE
   * projected, but the window is not finished, so the cursor must not move and
   * the run pages (review fix A5).
   */
  truncated: boolean;
  /**
   * What the watermark advances to once the projection succeeds = the window's
   * own end. Only meaningful when `truncated` is false; a truncated window has
   * no prefix it can honestly claim (see MAX_CHANGED_STAGE_IDS).
   */
  resumeTo: string;
}

/**
 * Stage ids whose ledger rows were inserted or updated since the watermark.
 * `occurred_at` never moves, so a re-posted OLD conversion can only be found by
 * `updated_at`. Cross-org, like the poll itself.
 *
 * The window is [min(watermark − overlap, now − lookback), now]: the lookback is
 * a FLOOR on how far back to look (and the whole window on a first run), and the
 * watermark extends it further back after failed or killed ticks — the opposite
 * choice (clamping to the lookback) is what stranded changed rows. The row is
 * self-creating so a first run has a cursor to advance.
 */
export async function discoverChangedLedgerStages(
  dbc: DbOrTx,
  opts: { lookbackMinutes?: number; limit?: number } = {},
): Promise<ProjectionDiscovery> {
  const lookback = opts.lookbackMinutes ?? LEDGER_CHANGE_LOOKBACK_MINUTES;
  const limit = opts.limit ?? MAX_CHANGED_STAGE_IDS;
  const [win] = (await dbc.execute(sql`
    WITH wm AS (
      INSERT INTO cron_locks (job_name) VALUES (${PROJECTION_JOB_NAME})
      ON CONFLICT (job_name) DO UPDATE SET job_name = cron_locks.job_name
      RETURNING watermark
    )
    SELECT wm.watermark::text AS watermark_from,
           LEAST(
             coalesce(wm.watermark - make_interval(mins => ${PROJECTION_WATERMARK_OVERLAP_MINUTES}::int),
                      now() - make_interval(mins => ${lookback}::int)),
             now() - make_interval(mins => ${lookback}::int)
           )::text AS window_from,
           now()::text AS window_to
    FROM wm
  `)) as unknown as { watermark_from: string | null; window_from: string; window_to: string }[];

  // Oldest change first: when the cap bites, the ids kept are the ones that have
  // waited longest (and `limit + 1` is what detects the cap biting at all). It is
  // NOT a progress claim — a truncated window holds the cursor.
  const rows = (await dbc.execute(sql`
    SELECT ce.stage_id, max(ce.updated_at)::text AS last_changed
    FROM conversion_events ce
    WHERE ce.stage_id IS NOT NULL
      AND ce.updated_at >= ${win.window_from}::timestamptz
      AND ce.updated_at <= ${win.window_to}::timestamptz
    GROUP BY 1
    ORDER BY max(ce.updated_at), ce.stage_id
    LIMIT ${limit + 1}::int
  `)) as unknown as { stage_id: number; last_changed: string }[];
  const truncated = rows.length > limit;
  const kept = truncated ? rows.slice(0, limit) : rows;

  return {
    watermarkFrom: win.watermark_from,
    windowFrom: win.window_from,
    windowTo: win.window_to,
    stageIds: kept.map((r) => Number(r.stage_id)),
    truncated,
    resumeTo: win.window_to,
  };
}

/** Move the discovery cursor forward. Never backwards, whoever ran last. */
export async function advanceProjectionWatermark(dbc: DbOrTx, to: string): Promise<string | null> {
  const rows = (await dbc.execute(sql`
    UPDATE cron_locks
    SET watermark = GREATEST(coalesce(watermark, ${to}::timestamptz), ${to}::timestamptz)
    WHERE job_name = ${PROJECTION_JOB_NAME}
    RETURNING watermark::text AS watermark
  `)) as unknown as { watermark: string | null }[];
  return rows[0]?.watermark ?? null;
}

export interface StageDayProjectionRun extends StageDayConversionSync {
  discovery: ProjectionDiscovery;
  /** cron_locks.watermark after the run — unchanged when the cursor was held. */
  watermarkTo: string | null;
  /**
   * The cursor was deliberately left where it was: the run refused, or discovery
   * was truncated so the window is unfinished. Either way the next tick re-reads
   * the same window, and the caller must page (see projectionOutcomeFor).
   */
  watermarkHeld: boolean;
}

/**
 * One scheduled projection: discover the changed stages, project them together
 * with `extraStageIds` (the poll's click-window stages), then advance the
 * watermark — ONLY when the window was finished. A throw leaves the cursor where
 * it was (the UPDATE is simply never reached), and so do a refusal and a
 * truncated discovery.
 */
export async function runStageDayProjection(
  dbc: DbOrTx,
  opts: { extraStageIds?: number[]; lookbackMinutes?: number; limit?: number } = {},
): Promise<StageDayProjectionRun> {
  const discovery = await discoverChangedLedgerStages(dbc, opts);
  const scope = [...new Set([...(opts.extraStageIds ?? []), ...discovery.stageIds])];
  const sync = await syncStageDayConversions(dbc, { stageIds: scope });
  // Truncated: the kept stages were projected, but the window still holds
  // stages this run never named, and their `updated_at` is inside it — so
  // advancing past it would strand them for good.
  if (sync.refused !== null || discovery.truncated) {
    return { ...sync, discovery, watermarkTo: discovery.watermarkFrom, watermarkHeld: true };
  }
  return {
    ...sync,
    discovery,
    watermarkTo: await advanceProjectionWatermark(dbc, discovery.resumeTo),
    watermarkHeld: false,
  };
}
