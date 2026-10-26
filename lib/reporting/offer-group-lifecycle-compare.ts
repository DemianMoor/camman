// Compare offer_group_lifecycle_v2_mv (0226, Hot and Warm separate) against the
// old offer_group_lifecycle_mv (0215, Hot/Warm merged) — PURE, no database.
// Used by scripts/verify-offer-group-lifecycle-v2.ts after the first fill;
// pinned by scripts/test-offer-group-lifecycle-compare.ts.
//
// The owner's bar (2026-10-26): same rows, zero NULLs, Cold and Freeze identical
// per cell, Hot + Warm = old Hot/Warm per cell. The two views are refreshed
// minutes apart, so a difference can be DRIFT; every differing cell is counted
// and sampled — never absorbed into a tolerance.

export type LifecycleViewRow = Record<string, string | number | null | undefined>;

export const LIFECYCLE_SPLIT_WINDOWS = ["sent_14d", "sent_30d", "fresh_pool"] as const;
export const LIFECYCLE_SAME_COLUMNS = [
  "cold_sent_14d", "cold_sent_30d", "cold_fresh_pool",
  "freeze_sent_14d", "freeze_sent_30d", "freeze_fresh_pool",
] as const;
export const LIFECYCLE_V2_COLUMNS = [
  ...LIFECYCLE_SPLIT_WINDOWS.flatMap((w) => [`hot_${w}`, `warm_${w}`]),
  ...LIFECYCLE_SAME_COLUMNS,
];

export interface CellDiff {
  cells: number;
  net: number;
  abs: number;
  samples: string[];
}

export interface LifecycleCompareResult {
  oldRows: number;
  newRows: number;
  lost: string[];
  added: string[];
  nullCells: number;
  /** Per cold/freeze column. */
  same: Record<string, CellDiff>;
  /** Per window: hot_<w> + warm_<w> vs hw_<w>. */
  hotWarm: Record<string, CellDiff>;
  totals: Record<string, { old: number; neu: number }>;
  ok: boolean;
}

const key = (r: LifecycleViewRow) => `${r.org_id}|${r.offer_id}|${r.group_id}`;
const blank = (): CellDiff => ({ cells: 0, net: 0, abs: 0, samples: [] });

export function compareLifecycleViews(
  oldRows: readonly LifecycleViewRow[],
  newRows: readonly LifecycleViewRow[],
): LifecycleCompareResult {
  const oldBy = new Map(oldRows.map((r) => [key(r), r]));
  const newBy = new Map(newRows.map((r) => [key(r), r]));
  const lost = [...oldBy.keys()].filter((k) => !newBy.has(k));
  const added = [...newBy.keys()].filter((k) => !oldBy.has(k));
  const nullCells = newRows.reduce(
    (a, r) => a + LIFECYCLE_V2_COLUMNS.filter((c) => r[c] === null || r[c] === undefined).length,
    0,
  );

  const same: Record<string, CellDiff> = Object.fromEntries(LIFECYCLE_SAME_COLUMNS.map((c) => [c, blank()]));
  const hotWarm: Record<string, CellDiff> = Object.fromEntries(LIFECYCLE_SPLIT_WINDOWS.map((w) => [w, blank()]));
  const totals: Record<string, { old: number; neu: number }> = {};
  const note = (d: CellDiff, delta: number, where: string) => {
    if (delta === 0) return;
    d.cells++;
    d.net += delta;
    d.abs += Math.abs(delta);
    if (d.samples.length < 5) d.samples.push(`${where} ${delta > 0 ? "+" : ""}${delta}`);
  };
  const total = (label: string, o: number, n: number) => {
    const t = (totals[label] ??= { old: 0, neu: 0 });
    t.old += o;
    t.neu += n;
  };

  for (const [k, n] of newBy) {
    const o = oldBy.get(k);
    if (!o) continue;
    const where = `offer ${n.offer_id} / group ${n.group_id}`;
    for (const c of LIFECYCLE_SAME_COLUMNS) {
      note(same[c], Number(n[c]) - Number(o[c]), where);
      total(c, Number(o[c]), Number(n[c]));
    }
    for (const w of LIFECYCLE_SPLIT_WINDOWS) {
      const sum = Number(n[`hot_${w}`]) + Number(n[`warm_${w}`]);
      note(hotWarm[w], sum - Number(o[`hw_${w}`]), where);
      total(`hot+warm ${w} vs hw_${w}`, Number(o[`hw_${w}`]), sum);
    }
  }

  const ok =
    oldRows.length === newRows.length &&
    lost.length === 0 &&
    added.length === 0 &&
    nullCells === 0 &&
    Object.values(same).every((d) => d.cells === 0) &&
    Object.values(hotWarm).every((d) => d.cells === 0);
  return { oldRows: oldRows.length, newRows: newRows.length, lost, added, nullCells, same, hotWarm, totals, ok };
}
