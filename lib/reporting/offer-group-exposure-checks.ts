// Pure checks for offer_group_exposure_mv (migration 0227) — used by
// scripts/verify-offer-group-exposure.ts after the first fill, pinned by
// scripts/test-offer-group-exposure-checks.ts. No database access here.
//
// The bar (owner, 2026-10-27), over every (org, offer, group) row:
//   E1  same keys as offer_group_lifecycle_v2_mv (0 lost, 0 added) — both
//       views are built over the same (offer, group) universe
//   E2  zero NULL cells, zero negative cells
//   E3  eligible <= x0 + x1 on every cell (2x+ is never eligible at limit 2)
//   E4  x0 + x1 + x2plus is the SAME for every offer of a group, per cohort:
//       it is the cohort's sendable contacts in the group and does not depend
//       on the offer. One snapshot, so this holds exactly — no drift allowance.
// And, reported but not a pass/fail bar, the 0x gap: x0 against v2's
// <cohort>_fresh_pool, the column 0x replaces on screen (it reads
// offer_exposures; 0x reads contact_offer_campaigns).

export const EXPOSURE_COHORTS = ["hot", "warm", "cold", "freeze"] as const;
export const EXPOSURE_BUCKETS = ["x0", "x1", "x2plus", "eligible"] as const;
export const EXPOSURE_VIEW_COLUMNS = EXPOSURE_COHORTS.flatMap((c) =>
  EXPOSURE_BUCKETS.map((b) => `${c}_${b}`),
);

type Row = Record<string, unknown>;

const keyOf = (r: Row) => `${r.org_id}|${r.offer_id}|${r.group_id}`;
const num = (v: unknown) => Number(v);

export type ExposureCheckResult = {
  rows: number;
  lost: string[];
  added: string[];
  nullCells: number;
  negativeCells: number;
  eligibleOver: string[];
  /** (org|group|cohort) whose x0+x1+x2plus differs between offers. */
  partitionMismatches: string[];
  totals: Record<string, number>;
};

export function checkExposureView(exposure: Row[], lifecycleV2: Row[]): ExposureCheckResult {
  const expKeys = new Set(exposure.map(keyOf));
  const v2Keys = new Set(lifecycleV2.map(keyOf));
  const totals = Object.fromEntries(EXPOSURE_VIEW_COLUMNS.map((c) => [c, 0]));
  let nullCells = 0;
  let negativeCells = 0;
  const eligibleOver: string[] = [];
  const sendable = new Map<string, Set<number>>();

  for (const r of exposure) {
    for (const c of EXPOSURE_VIEW_COLUMNS) {
      if (r[c] === null || r[c] === undefined) nullCells++;
      else if (num(r[c]) < 0) negativeCells++;
      totals[c] += num(r[c] ?? 0);
    }
    for (const c of EXPOSURE_COHORTS) {
      if (num(r[`${c}_eligible`]) > num(r[`${c}_x0`]) + num(r[`${c}_x1`]))
        eligibleOver.push(`${keyOf(r)} ${c}`);
      const k = `${r.org_id}|${r.group_id}|${c}`;
      const set = sendable.get(k) ?? new Set<number>();
      set.add(num(r[`${c}_x0`]) + num(r[`${c}_x1`]) + num(r[`${c}_x2plus`]));
      sendable.set(k, set);
    }
  }
  return {
    rows: exposure.length,
    lost: [...v2Keys].filter((k) => !expKeys.has(k)),
    added: [...expKeys].filter((k) => !v2Keys.has(k)),
    nullCells,
    negativeCells,
    eligibleOver,
    partitionMismatches: [...sendable].filter(([, s]) => s.size > 1).map(([k, s]) => `${k}: ${[...s].join("/")}`),
    totals,
  };
}

export type ExposureGap = {
  cohort: string;
  oldFresh: number;
  newX0: number;
  cellsDiffering: number;
  /** Largest |x0 − fresh_pool| on one cell, and that difference as % of the old cell (null when the old cell is 0). */
  maxCellDiff: number;
  maxCellDiffPct: number | null;
  maxCellKey: string | null;
};

export function exposureGap(exposure: Row[], lifecycleV2: Row[]): ExposureGap[] {
  const v2 = new Map(lifecycleV2.map((r) => [keyOf(r), r]));
  return EXPOSURE_COHORTS.map((c) => {
    const g: ExposureGap = {
      cohort: c, oldFresh: 0, newX0: 0, cellsDiffering: 0, maxCellDiff: 0, maxCellDiffPct: null, maxCellKey: null,
    };
    for (const r of exposure) {
      const o = v2.get(keyOf(r));
      if (!o) continue;
      const oldV = num(o[`${c}_fresh_pool`]);
      const newV = num(r[`${c}_x0`]);
      g.oldFresh += oldV;
      g.newX0 += newV;
      const d = Math.abs(newV - oldV);
      if (d > 0) g.cellsDiffering++;
      if (d > g.maxCellDiff) {
        g.maxCellDiff = d;
        g.maxCellDiffPct = oldV > 0 ? (d / oldV) * 100 : null;
        g.maxCellKey = keyOf(r);
      }
    }
    return g;
  });
}
