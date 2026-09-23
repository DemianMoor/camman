/**
 * The /reports row order — ONE definition of the key sequence, used by both the
 * Overview tab (sorted server-side in app/api/keitaro/reports/route.ts, BEFORE
 * the page slice, so a secondary key has to live there and cannot be a
 * client-side flourish) and the By-X tabs (sorted in the browser in
 * components/reports/performance-report.tsx).
 *
 * The order is always:
 *
 *   1. the clicked column          — direction-flipped (asc/desc)
 *   2. Clickers, high → low        — NEVER flipped; skipped when the primary IS
 *                                    Clickers
 *   3. the row's stable identity   — NEVER flipped; ascending
 *
 * ⭐ WHY THE FLIP IS APPLIED TO THE PRIMARY ALONE, AND WHY THAT IS A BUG FIX.
 * Both comparators used to fold the tie-break into `cmp` and then negate the
 * WHOLE thing for a descending sort (`return sortDir === "asc" ? cmp : -cmp`).
 * A tie-break behind that negation reverses with the sort: rows tied on the
 * primary came out in one order descending and the exact opposite order
 * ascending, which is precisely what a tie-break exists to prevent. The
 * direction is a property of the column the operator clicked; the secondary and
 * the stable key are properties of the TABLE, so they are applied after the
 * negation, not through it.
 *
 * Pure — no React, no DB, no env. Covered by scripts/test-report-sort.ts.
 */

export type SortDir = "asc" | "desc";

export interface ReportSortKeys {
  /**
   * ⚠️ THE `clickers` FIELD, NOT `counted_clickers`. `clickers` is
   * `visit_clicks_clean` — Keitaro's clean landing visits, the column Overview
   * heads `Clickers` and the By-X tables head `Landing visits`.
   * `counted_clickers` is the deduplicated human-scored EPC denominator, a
   * DIFFERENT number that orders rows differently. Reading the wrong one here
   * fails silently: the rows are still sorted, just by a metric the operator
   * cannot see. Bar S11 in scripts/test-report-sort.ts pins it with a fixture
   * whose two fields rank the rows in opposite orders.
   */
  clickers: number;
  /**
   * Row identity, compared left to right, ascending, never flipped. Its only
   * job is determinism: two rows that tie on everything visible must still come
   * out in the same order on every request, or the table jitters between
   * reloads and between pages.
   */
  stableKeys: readonly (number | string)[];
}

function compareStable(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * Finish a comparison: apply the direction to `primaryCmp`, then the two
 * never-flipped tie-breaks. `primaryCmp` is the raw comparison of the clicked
 * column (a < b ⇒ negative), NOT yet direction-adjusted.
 */
export function applyReportSortKeys(
  primaryCmp: number,
  sortDir: SortDir,
  a: ReportSortKeys,
  b: ReportSortKeys,
  primaryIsClickers = false,
): number {
  const primary = sortDir === "asc" ? primaryCmp : -primaryCmp;
  if (primary !== 0) return primary;

  // Clickers descending, whatever the primary direction is. Skipped when the
  // primary IS Clickers: rows can only reach here with equal Clickers, so the
  // comparison is 0 by construction — saying so is clearer than relying on it.
  if (!primaryIsClickers && a.clickers !== b.clickers) {
    return b.clickers - a.clickers;
  }

  const n = Math.min(a.stableKeys.length, b.stableKeys.length);
  for (let i = 0; i < n; i++) {
    const c = compareStable(a.stableKeys[i], b.stableKeys[i]);
    if (c !== 0) return c;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Overview (app/api/keitaro/reports/route.ts)
// ---------------------------------------------------------------------------

export interface OverviewSortRow {
  campaign_name: string;
  campaign_id: number;
  stage_id: number | null;
  /** `visit_clicks_clean` — see ReportSortKeys.clickers. */
  clickers: number;
}

const overviewKeys = (r: OverviewSortRow): ReportSortKeys => ({
  clickers: r.clickers,
  // BOTH ids, in this order. `groupBy=campaign` gives one row per campaign and
  // `campaign_id` alone is unique; `groupBy=stage` gives one row per STAGE, so
  // campaign_id repeats across a campaign's stages and only `stage_id`
  // separates them. A campaign row's stage_id is null and collapses to the same
  // sentinel on every row, which is harmless there because campaign_id has
  // already decided.
  stableKeys: [r.campaign_id, r.stage_id ?? -1],
});

/**
 * Overview's comparator. `eventValue` is non-null only when the clicked column
 * is a GENERATED per-event column; the caller resolves the column id once and
 * closes over it, so this module needs no knowledge of that id grammar.
 */
export function makeOverviewComparator<T extends OverviewSortRow>(
  sortBy: string,
  sortDir: SortDir,
  eventValue: ((row: T) => number | null) | null,
): (a: T, b: T) => number {
  const primaryIsClickers = sortBy === "clickers";
  return (a, b) => {
    let cmp: number;
    if (sortBy === "campaign_name") {
      cmp = a.campaign_name.localeCompare(b.campaign_name);
    } else if (eventValue) {
      // A null (unknown ratio) sorts LAST in BOTH directions — "we cannot say"
      // is not "zero", and it must not win a descending sort over a real 0.0%.
      // The early `return` skips the tie-breaks on purpose: there is no
      // ordering between a knowable row and an unknowable one to refine. Two
      // unknowns DO fall through — they are tied, not incomparable.
      const av = eventValue(a);
      const bv = eventValue(b);
      if (av == null && bv == null) cmp = 0;
      else if (av == null) return 1;
      else if (bv == null) return -1;
      else cmp = av - bv;
    } else {
      // THE SAME nulls-last RULE AS THE EVENT BRANCH ABOVE AND AS By-X's
      // comparator below — not a `?? 0` coercion. A missing value is "we
      // cannot say", not zero: coerced to 0 it lands wherever 0 happens to
      // fall, which on a column that can go negative (Profit) is the MIDDLE of
      // the table descending and the TOP of it ascending. That is the opposite
      // of the rule docs/07-conventions.md states and of what the other two
      // branches do. Inert on today's roster — every whitelisted Overview sort
      // id is a plain number on every row — so this changes no order anyone
      // can produce today; it is here so the next nullable sortable column
      // inherits the stated rule instead of the coercion. Like the event
      // branch, the early `return` skips the tie-breaks on purpose: there is
      // no ordering between a knowable row and an unknowable one to refine.
      const av = (a as unknown as Record<string, number | null | undefined>)[sortBy];
      const bv = (b as unknown as Record<string, number | null | undefined>)[sortBy];
      if (av == null && bv == null) cmp = 0;
      else if (av == null) return 1;
      else if (bv == null) return -1;
      else cmp = av - bv;
    }
    return applyReportSortKeys(
      cmp,
      sortDir,
      overviewKeys(a),
      overviewKeys(b),
      primaryIsClickers,
    );
  };
}

// ---------------------------------------------------------------------------
// By-X (components/reports/performance-report.tsx)
// ---------------------------------------------------------------------------

export interface DimensionSortRow {
  /**
   * The dimension's own identity — the phone id, the offer id, the sequence
   * slot, the group id, the hour, "manual". Every dimension builds it in
   * lib/reporting/performance-report.ts and it is unique within a response,
   * which is exactly what a stable key needs; `label` is a display string and
   * two dimensions can render the same one.
   */
  key: string;
  /** `visit_clicks_clean` — see ReportSortKeys.clickers. */
  clickers: number;
  /** Hourly's "Manual" roll-up row, pinned to the top of the table. */
  pinned?: boolean;
}

const dimensionKeys = (r: DimensionSortRow): ReportSortKeys => ({
  clickers: r.clickers,
  stableKeys: [r.key],
});

/**
 * A By-X tab's comparator. `value` reads the clicked column off the row (a
 * generated column is COMPUTED from the row's event map, which is why the
 * caller passes a reader rather than a field name).
 */
export function makeDimensionComparator<T extends DimensionSortRow>(
  sortDir: SortDir,
  primaryIsClickers: boolean,
  value: (row: T) => number | string | null,
): (a: T, b: T) => number {
  return (a, b) => {
    // Pinned rows (hourly "Manual") always sort to the top — ahead of the
    // direction, the secondary and the stable key alike.
    if (a.pinned && !b.pinned) return -1;
    if (b.pinned && !a.pinned) return 1;
    const av = value(a);
    const bv = value(b);
    // "Unknown" sorts LAST in BOTH directions — it is not a small number. Same
    // rule as Overview's comparator above.
    if (av == null && bv != null) return 1;
    if (bv == null && av != null) return -1;
    const cmp =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av ?? "").localeCompare(String(bv ?? ""));
    return applyReportSortKeys(
      cmp,
      sortDir,
      dimensionKeys(a),
      dimensionKeys(b),
      primaryIsClickers,
    );
  };
}
