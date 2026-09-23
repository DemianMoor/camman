/**
 * What a header click does to the sort — as a pure function, so the rule can be
 * tested without a browser and so a screen can choose its cycle instead of
 * inheriting one.
 *
 * ⭐ THE CYCLE IS OPT-IN BECAUSE THE TABLE WRAPPER IS SHARED. Twenty screens
 * render `components/data-table.tsx`; only /reports Overview wants the owner's
 * two-state cycle. `asc-desc-clear` is therefore the DEFAULT and must stay
 * behaviourally identical to what `cycleSort` did before this file existed —
 * changing the default would silently re-teach every registry list at once.
 */
export type SortCycle =
  /** Historical: ascending, then descending, then no sort at all. */
  | "asc-desc-clear"
  /**
   * /reports: descending first (the interesting end of a metric is the top of
   * the list), ascending second, and NEVER cleared — an unsorted report is a
   * step the owner said he will never want. The third click flips back to
   * descending, which is exactly what the By-X tables' own `toggleSort` has
   * always done; the two tabs must not disagree about what a click means.
   */
  | "desc-asc";

export interface SortState {
  sortBy: string | null;
  sortDir: "asc" | "desc";
}

/**
 * The next sort state after clicking `clickedColumnId`'s header.
 *
 * Pure: no component state, no DOM. `current.sortBy` is the column the table is
 * sorted by right now (null = unsorted), `current.sortDir` its direction.
 */
export function nextSortState(
  current: SortState,
  clickedColumnId: string,
  cycle: SortCycle = "asc-desc-clear",
): SortState {
  if (cycle === "desc-asc") {
    // A fresh column always opens descending, whatever the previous column's
    // direction was — the direction belongs to the click, not to the table.
    if (current.sortBy !== clickedColumnId) {
      return { sortBy: clickedColumnId, sortDir: "desc" };
    }
    return {
      sortBy: clickedColumnId,
      sortDir: current.sortDir === "desc" ? "asc" : "desc",
    };
  }

  // Default — byte-for-byte the old `cycleSort`: asc → desc → cleared. The
  // cleared state keeps `desc` as its direction (that is what the old code
  // passed, and a null `sortBy` makes the direction unobservable anyway).
  if (current.sortBy !== clickedColumnId) {
    return { sortBy: clickedColumnId, sortDir: "asc" };
  }
  if (current.sortDir === "asc") {
    return { sortBy: clickedColumnId, sortDir: "desc" };
  }
  return { sortBy: null, sortDir: "desc" };
}
