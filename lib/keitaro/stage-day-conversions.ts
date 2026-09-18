import { sql, type SQL } from "drizzle-orm";

import type { db } from "@/db/client";
import { CAMPAIGN_TIMEZONE } from "@/lib/campaign-timezone";
import { mirrorStageCountersFromResults } from "@/lib/keitaro/poll";
import {
  approvedRevenueClause,
  countedClause,
  pendingRevenueClause,
  purchasedClause,
} from "@/lib/sale-attribution";

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
// unscoped run names every stage in the org.
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

// ⭐ THE COLUMNS THIS MODULE DERIVES, AS ONE LIST. The upsert's change test and
// the resync's dry-run diff (readStageDayResyncDiff) are both built from it, so
// "the diff IS the predicate --apply uses" is structural instead of a promise in
// a comment. It stopped being true once before: Phase 5 added `events` /
// `unmapped_conversions` to the write and to the zeroing test, and the script's
// hand-retyped copy of both predicates was left behind — the preview an operator
// approved no longer described the run. A column added here reaches both sides or
// neither. Bars R1-R8 in scripts/test-stage-day-conversions.ts execute the diff
// and the apply against one world and require the row sets to be EQUAL.
//
// The ledger CTE names its payout column `payout_at_conversion` (not `payout`)
// for the same reason: identical names on both sides are what let one builder
// emit the test for `keitaro_stage_results` vs `EXCLUDED` and for `k` vs `l`.
const PROJECTED_COLUMNS = [
  "checkouts",
  "sales",
  "revenue",
  "pending_revenue",
  "events",
  "unmapped_conversions",
  "payout_at_conversion",
] as const;

/** `(a.col IS DISTINCT FROM b.col OR …)` over every projected column. */
function projectionChangedClause(a: string, b: string): SQL {
  return sql`(${sql.join(
    PROJECTED_COLUMNS.map(
      (c) => sql`${sql.raw(a)}.${sql.raw(c)} IS DISTINCT FROM ${sql.raw(b)}.${sql.raw(c)}`,
    ),
    sql` OR `,
  )})`;
}

/**
 * `(a.<col> is not its zeroed value OR …)` — "this stored row still reports a
 * conversion". The zeroing UPDATE's content test and the diff's `zero` branch are
 * the same fragment. `payout_at_conversion` is deliberately NOT in it: it is
 * derived from sales/revenue, so a row whose six content columns are already
 * empty has nothing to zero, and adding it would widen the set of rows the
 * UPDATE touches rather than describe it.
 */
function projectionNonEmptyClause(a: string): SQL {
  const q = sql.raw(a);
  return sql`(${q}.checkouts <> 0 OR ${q}.sales <> 0 OR ${q}.revenue <> 0 OR ${q}.pending_revenue <> 0
       OR ${q}.events <> '{}'::jsonb OR ${q}.unmapped_conversions <> 0)`;
}

/**
 * THE LEDGER-DERIVED STAGE-DAY, as CTE text: `per_event`, `ledger_raw`, `ledger`.
 * `ledger` carries one row per (org, stage, ET day) with EVERY projected column
 * under its stored name. The upsert selects straight out of it; the resync's dry
 * run joins the stored rows against it. Shared, not retyped — see
 * PROJECTED_COLUMNS.
 *
 * ⭐ THE SCALARS ARE SUMS OF THE PER-EVENT PARTIALS, NOT INDEPENDENT FILTERS. One
 * pass over conversion_events, grouped one level finer (by event_types.key), then
 * rolled up:
 *     sales   = Σ events[t].n     over is_purchase types
 *     revenue = Σ events[t].revenue
 * ⚠️ …WITH A RESIDUAL, and the two CAN differ by it. `sales` / `revenue` resolve
 * the flags through the NON-org-scoped PURCHASE_EVENT_TYPE_IDS /
 * REVENUE_EVENT_TYPE_IDS (lib/sale-attribution.ts) while the per-event side
 * resolves them through the ORG-SCOPED join below, so a ledger row carrying
 * ANOTHER org's event_type_id is counted by the scalar and placed in no entry. It
 * is counted in `unmapped_conversions` instead — that is what the `et.key IS NULL`
 * bucket is for. The identity is `sales = Σ (is_purchase) n + strays`, asserted
 * WITH the residual by bars P23c/P14b and pinned non-zero by P23d/P14c.
 *
 * The two expressions are still computed SEPARATELY inside `per_event` — `sales`
 * via SALES_FILTER (purchasedClause) and `n` via countedClause + the is_purchase
 * join — and scripts/test-stage-day-conversions.ts asserts they agree. That is
 * deliberate and is NOT a tautology: it is the guard that goes red if the shared
 * clauses in lib/sale-attribution.ts are ever changed without the per-event side
 * following.
 *
 * ⚠️ THE JOIN CARRIES org_id AS WELL AS THE ID (CLAUDE.md §3). event_types.id is a
 * global serial; joining on the id alone would let one org's registry name another
 * org's column.
 *
 * ⚠️ LEFT JOIN, not JOIN. An UNMAPPED row (no event type, or no status) must still
 * reach this statement: it lands in the event_key IS NULL group, is counted into
 * unmapped_conversions, and is FILTERed out of the `events` object — stored,
 * surfaced, counted as nothing. An inner join would drop it and the badge would
 * never fire.
 *
 * ⚠️ jsonb_object_agg CANNOT get a duplicate key here: the outer group is
 * (org_id, stage_id, stat_date), every row in it shares one org, and
 * event_types_org_key_uniq (migration 0181) makes `key` unique within an org.
 */
function stageDayLedgerCtes(scope: SQL): SQL {
  return sql`
    per_event AS (
      SELECT ce.org_id,
             ce.stage_id,
             (ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date AS stat_date,
             et.key AS event_key,
             count(*) FILTER (WHERE ${SALES_FILTER})::int AS sales,
             count(*) FILTER (WHERE ${CHECKOUT_FILTER})::int AS checkouts,
             coalesce(sum(ce.revenue) FILTER (WHERE ${REVENUE_FILTER}), 0)::numeric(12, 4) AS revenue,
             coalesce(sum(ce.revenue) FILTER (WHERE ${PENDING_REVENUE_FILTER}), 0)::numeric(12, 4) AS pending_revenue,
             -- The per-event generalisations: the flag half is the join, the
             -- status half is the shared clause.
             count(*) FILTER (WHERE ${countedClause()})::int AS n,
             count(*) FILTER (WHERE ce.status = 'pending')::int AS pending_n,
             coalesce(sum(ce.revenue) FILTER (WHERE et.counts_revenue AND ce.status = 'approved'), 0)::numeric(12, 4) AS ev_revenue,
             coalesce(sum(ce.revenue) FILTER (WHERE et.counts_revenue AND ce.status = 'pending'), 0)::numeric(12, 4) AS ev_pending_revenue,
             -- ⭐ KEYED ON THE JOIN RESULT (et.key IS NULL), NOT ON THE RAW
             -- COLUMN (ce.event_type_id IS NULL). The index's own predicate is
             -- the raw-column form, and copying it here would leave a hole:
             -- PURCHASE_EVENT_TYPE_IDS / REVENUE_EVENT_TYPE_IDS resolve the flags
             -- through a NON-org-scoped subquery (lib/sale-attribution.ts) while
             -- this join is org-scoped, so a ledger row carrying ANOTHER ORG'S
             -- event_type_id — which the FK permits, there being no composite
             -- (id, org_id) FK — would be counted by SALES_FILTER, placed in no
             -- events entry, and not counted unmapped either. It would be
             -- invisible on every surface Phase 5 adds, including the badge whose
             -- entire purpose is to reveal rows that count as nothing.
             --
             -- Keying on et.key makes the two buckets a PARTITION: every row on
             -- the stage-day is either PLACED (same-org key AND a non-NULL status)
             -- or counted here. Fixture foreign_type proves it. It also makes this
             -- column BROADER than conversion_events_unmapped_idx's predicate, and
             -- broader than the monitor's Telegram alert — deliberately; see the
             -- column comment in db/schema.ts.
             count(*) FILTER (WHERE et.key IS NULL OR ce.status IS NULL)::int AS unmapped_n
      FROM conversion_events ce
      LEFT JOIN event_types et ON et.id = ce.event_type_id AND et.org_id = ce.org_id
      WHERE ce.stage_id ${scope}
      GROUP BY 1, 2, 3, 4
    ),
    ledger_raw AS (
      SELECT org_id, stage_id, stat_date,
             sum(sales)::int AS sales,
             sum(checkouts)::int AS checkouts,
             sum(revenue)::numeric(12, 4) AS revenue,
             sum(pending_revenue)::numeric(12, 4) AS pending_revenue,
             sum(unmapped_n)::int AS unmapped_conversions,
             -- An entry that is zero on EVERY field is omitted, so a stage-day
             -- whose only row is a rejected purchase reads '{}' rather than a
             -- row of zeros that looks like a configured-but-idle event type.
             coalesce(
               jsonb_object_agg(
                 event_key,
                 jsonb_build_object(
                   'n', n,
                   'pending_n', pending_n,
                   'revenue', ev_revenue,
                   'pending_revenue', ev_pending_revenue
                 )
               ) FILTER (
                 WHERE event_key IS NOT NULL
                   AND (n <> 0 OR pending_n <> 0 OR ev_revenue <> 0 OR ev_pending_revenue <> 0)
               ),
               '{}'::jsonb
             ) AS events
      FROM per_event
      GROUP BY 1, 2, 3
    ),
    -- The per-unit rate, in its own level because an aggregate's output alias
    -- cannot be referenced from the SELECT list that produced it.
    ledger AS (
      SELECT r.*,
             CASE WHEN r.sales > 0 THEN (r.revenue / r.sales)::numeric(12, 4) ELSE NULL END
               AS payout_at_conversion
      FROM ledger_raw r
    )`;
}

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
  // rows: the healthy case matches no rows, so the guard answers NULL without
  // aggregating anything.
  //
  // ⚠️ IT IS A SEQUENTIAL SCAN, and an earlier version of this comment claimed
  // otherwise. No index serves `stat_date < …` on this table:
  // keitaro_stage_results_campaign_date_idx is (campaign_id, stat_date) and
  // stat_date is NOT its leading column, so the range cannot be probed through
  // it; keitaro_stage_results_stage_date_uniq is (org_id, stage_id, stat_date),
  // same problem. The cost is a scan plus filter over the whole table (~17.6K
  // rows in production) on every */5 tick — cheap at this size, which is why no
  // index is being added for it, but it is a scan and it grows with the table.
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
               AND (k.checkouts <> 0 OR k.sales <> 0 OR k.revenue <> 0 OR k.pending_revenue <> 0
                    -- Phase 5: two more columns now "report a conversion". Without
                    -- them a historical stage-day carrying ONLY registrations, or
                    -- only unmapped rows, could never trip the global
                    -- ledger_behind_history refusal — the projection would
                    -- happily run against a ledger that does not reach back that
                    -- far and zero it. Moot on day one (every pre-0185 row is
                    -- '{}' / 0) and asymmetric for ever after, which is exactly
                    -- the kind of guard that rots quietly.
                    OR k.events <> '{}'::jsonb OR k.unmapped_conversions <> 0)
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

  // The ledger-derived rows (stageDayLedgerCtes) written onto the stage-day.
  // The change test is projectionChangedClause over PROJECTED_COLUMNS — the same
  // builder the resync's dry run uses — so a column that starts being written is
  // a column the preview starts listing. Two of the seven are there for a reason
  // worth keeping written down:
  //   • events / unmapped_conversions — without them a stage-day whose SCALARS
  //     did not move but whose BREAKDOWN did (a registration arriving where a
  //     purchase already sat, a mapping healing an unmapped row) would never be
  //     rewritten, and the new columns would freeze at their first value;
  //   • payout_at_conversion is derived from sales/revenue, so it only differs on
  //     its own when a row predates the column or was written NULL by an older
  //     path. Without it the stale/NULL payout can never be repaired.
  const written = (await dbc.execute(sql`
    WITH ${stageDayLedgerCtes(scope)}
    INSERT INTO keitaro_stage_results
      (org_id, campaign_id, stage_id, stage_tracking_id, stat_date,
       checkouts, sales, revenue, pending_revenue, events, unmapped_conversions, payout_at_conversion)
    SELECT l.org_id, cs.campaign_id, l.stage_id, coalesce(cs.tracking_id, ''), l.stat_date,
           l.checkouts, l.sales, l.revenue, l.pending_revenue, l.events, l.unmapped_conversions,
           l.payout_at_conversion
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
      events               = EXCLUDED.events,
      unmapped_conversions = EXCLUDED.unmapped_conversions,
      payout_at_conversion = EXCLUDED.payout_at_conversion,
      synced_at            = now()
    WHERE ${projectionChangedClause("keitaro_stage_results", "EXCLUDED")}
    RETURNING keitaro_stage_results.id AS id
  `)) as unknown as { id: number }[];

  // A COVERED day the ledger no longer explains. Only the CONVERSION columns are
  // reset — the click columns on the same row are the aggregate poll's, and a
  // stage-day with clicks and no conversions is normal. `pending_revenue`
  // (migration 0182) is reset with them: Task 6 starts writing it from the same
  // ledger read, and a column that is projected but never zeroed is exactly the
  // stale-higher-value bug this fix is about.
  //
  // ⚠️ "EXPLAINED" MUST NAME EVERY COLUMN THIS ZEROES, AND SINCE PHASE 5 THAT IS
  // EVERY LEDGER ROW. The predicate was a list of the filters the INSERT writes
  // from: first `SALES ∨ REVENUE ∨ PENDING` (safe only while the pre-Task-6
  // SALES_FILTER, `keitaro_type IN ('lead','sale','rejected')`, was a strict
  // SUPERSET of CHECKOUT_FILTER and implied the checkout side for free), then all
  // four, after Task 6 flipped SALES_FILTER to the ledger's purchase predicate and
  // broke that containment — a day whose only ledger rows were lead-TYPE
  // NON-purchases had `checkouts` written by the INSERT and zeroed here in the
  // SAME run, forever, dragging campaign_stages.checkout_click_count with it
  // (test PB1–PB4). Phase 5 retires the list entirely: `events` and
  // `unmapped_conversions` mean EVERY ledger row now writes something, so the
  // honest complement of the INSERT is "no ledger row on this stage-day at all".
  // See the ⭐ note on the anti-join below.
  //
  // The join to `cov` is the C1 bound: a stage absent from it (no ledger rows
  // at all) has NO row to zero, and `k.stat_date >= cov.floor_date` keeps
  // everything before that stage's earliest ledger conversion untouched.
  const zeroed = (await dbc.execute(sql`
    UPDATE keitaro_stage_results k
    SET checkouts = 0, sales = 0, revenue = 0, pending_revenue = 0,
        events = '{}'::jsonb, unmapped_conversions = 0,
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
      -- Shared with the dry run's zero branch (projectionNonEmptyClause), so a
      -- column that starts being zeroed is a column the preview starts listing.
      AND ${projectionNonEmptyClause("k")}
      -- ⭐ WIDENED IN PHASE 5, AND THIS IS NOT TIDYING. The predicate used to be
      -- the four filters the INSERT writes from (SALES / CHECKOUT / REVENUE /
      -- PENDING_REVENUE) — "is there a row here that makes a number?". Every
      -- ledger row now makes a number: a counted event of ANY type lands in
      -- the events object, and an unmapped row lands in
      -- unmapped_conversions. Left as it was, a stage-day whose only conversions
      -- are REGISTRATIONS satisfies "nothing here", and the UPDATE would wipe a
      -- non-empty breakdown and the unmapped count on a day the ledger fully
      -- explains. Fixture regonly_zeroing is the bar.
      --
      -- The widening can only ever PRESERVE a value, never invent one: it strictly
      -- reduces the set of rows this statement touches. The one shape it stops
      -- zeroing — a stage-day whose only rows are REJECTED — needs no zeroing,
      -- because the INSERT above already emits an all-zero row for it (the
      -- per_event group exists; every FILTER is empty).
      AND NOT EXISTS (
        SELECT 1 FROM conversion_events ce
        WHERE ce.stage_id = k.stage_id
          AND ce.org_id = k.org_id
          AND (ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date = k.stat_date
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
    ...coverage,
  };
}

/** One stage-day the resync would change, with the stored and ledger-derived values. */
export interface StageDayResyncDiff {
  stage_id: number;
  stat_date: string;
  /**
   * `insert` — the ledger explains a (stage, day) with no stored row.
   * `rewrite` — a stored row any projected column of which differs.
   * `zero` — a covered day the ledger no longer explains at all.
   */
  action: "insert" | "rewrite" | "zero";
  old_checkouts: number;
  new_checkouts: number;
  old_sales: number;
  new_sales: number;
  old_revenue: string;
  new_revenue: string;
  old_pending_revenue: string;
  new_pending_revenue: string;
  old_events: string;
  new_events: string;
  old_unmapped: number;
  new_unmapped: number;
  old_payout: string | null;
  new_payout: string | null;
}

/**
 * EXACTLY THE ROWS syncStageDayConversions WOULD CHANGE, read-only — the dry run
 * of scripts/resync-stage-day-conversions.ts, and the reason that script's
 * preview can be trusted.
 *
 * ⭐ IT IS THE PREDICATE, NOT AN APPROXIMATION OF IT, AND THAT IS NOW STRUCTURAL.
 * Every piece is the same object the write uses: the derivation is
 * stageDayLedgerCtes, the rewrite test is projectionChangedClause over
 * PROJECTED_COLUMNS (the upsert's own `WHERE`), the zero test is
 * projectionNonEmptyClause (the zeroing UPDATE's own content test) next to a
 * verbatim copy of its anti-join, and `stage_floor` is its `cov` subquery. The
 * script used to carry hand-retyped copies of all four, and they fell behind
 * twice: once when Task 6 changed what a sale is, once when Phase 5 added
 * `events` / `unmapped_conversions`. Bars R1-R8 in
 * scripts/test-stage-day-conversions.ts run this and the real write against ONE
 * world and require the two row sets to be equal.
 *
 * ⚠️ `ledger_written` re-applies the INSERT's JOIN to campaign_stages; `stage_floor`
 * deliberately does NOT. The two bounds genuinely differ on the write side — a
 * ledger row whose org does not match its stage writes nothing, while the zeroing
 * floor is computed over EVERY stage-attributed ledger row — and this diff has to
 * reproduce each one where it applies, not the nicer of the two.
 *
 * Coverage is NOT checked here: a caller must pre-flight readProjectionCoverage
 * itself, because a diff computed under a refusal reads as "every row must be
 * zeroed".
 */
export async function readStageDayResyncDiff(
  dbc: DbOrTx,
  opts: { stageIds?: number[] } = {},
): Promise<StageDayResyncDiff[]> {
  const ids = opts.stageIds;
  if (ids && ids.length === 0) return [];
  const scope: SQL = ids
    ? sql`IN (${sql.join(
        ids.map((id) => sql`${id}::int`),
        sql`, `,
      )})`
    : sql`IS NOT NULL`;

  return (await dbc.execute(sql`
    WITH ${stageDayLedgerCtes(scope)},
    ledger_written AS (
      SELECT l.* FROM ledger l
      JOIN campaign_stages cs ON cs.id = l.stage_id AND cs.org_id = l.org_id
    ),
    stage_floor AS (
      SELECT ce.org_id, ce.stage_id,
             min((ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date) AS floor_date
      FROM conversion_events ce
      WHERE ce.stage_id ${scope}
      GROUP BY 1, 2
    )
    SELECT coalesce(k.stage_id, l.stage_id) AS stage_id,
           coalesce(k.stat_date, l.stat_date)::text AS stat_date,
           CASE WHEN k.id IS NULL THEN 'insert'
                WHEN l.stage_id IS NOT NULL THEN 'rewrite'
                ELSE 'zero' END AS action,
           coalesce(k.checkouts, 0) AS old_checkouts,
           coalesce(l.checkouts, 0) AS new_checkouts,
           coalesce(k.sales, 0) AS old_sales,
           coalesce(l.sales, 0) AS new_sales,
           coalesce(k.revenue, 0)::text AS old_revenue,
           coalesce(l.revenue, 0)::text AS new_revenue,
           coalesce(k.pending_revenue, 0)::text AS old_pending_revenue,
           coalesce(l.pending_revenue, 0)::text AS new_pending_revenue,
           coalesce(k.events, '{}'::jsonb)::text AS old_events,
           coalesce(l.events, '{}'::jsonb)::text AS new_events,
           coalesce(k.unmapped_conversions, 0) AS old_unmapped,
           coalesce(l.unmapped_conversions, 0) AS new_unmapped,
           k.payout_at_conversion::text AS old_payout,
           l.payout_at_conversion::text AS new_payout
    FROM keitaro_stage_results k
    FULL OUTER JOIN ledger_written l
      ON l.stage_id = k.stage_id AND l.org_id = k.org_id AND l.stat_date = k.stat_date
    LEFT JOIN stage_floor f ON f.stage_id = k.stage_id AND f.org_id = k.org_id
    WHERE (
        l.stage_id IS NOT NULL AND (k.id IS NULL OR ${projectionChangedClause("k", "l")})
      )
      OR (
        k.id IS NOT NULL AND l.stage_id IS NULL
        -- Outside that stage's coverage nothing happens, so it is not a diff —
        -- same per-stage bound as syncStageDayConversions.
        AND f.floor_date IS NOT NULL AND k.stat_date >= f.floor_date
        AND ${projectionNonEmptyClause("k")}
        -- The zeroing UPDATE's anti-join, verbatim: "no ledger row on this
        -- stage-day at all", NOT a list of the filters that make a number.
        AND NOT EXISTS (
          SELECT 1 FROM conversion_events ce
          WHERE ce.stage_id = k.stage_id
            AND ce.org_id = k.org_id
            AND (ce.occurred_at AT TIME ZONE ${CAMPAIGN_TIMEZONE})::date = k.stat_date
        )
      )
    ORDER BY 1, 2
  `)) as unknown as StageDayResyncDiff[];
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
