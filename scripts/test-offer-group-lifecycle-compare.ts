// compareLifecycleViews (lib/reporting/offer-group-lifecycle-compare.ts) — PURE,
// no database. It is the arithmetic the production verification of migration
// 0226's first fill rests on, so each failure mode it must catch is fed to it
// once, on synthetic rows, and the clean case must pass.
//
// Run: npx tsx scripts/test-offer-group-lifecycle-compare.ts

import {
  compareLifecycleViews,
  type LifecycleViewRow,
} from "../lib/reporting/offer-group-lifecycle-compare";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

// One (offer, group) cell in both shapes, built from per-status numbers so the
// "correct" new row is derived, not typed.
const cell = (offer: number, group: number, hot: number, warm: number, cold: number, freeze: number) => {
  const per = (n: number) => ({ sent_14d: n, sent_30d: 2 * n, fresh_pool: 3 * n });
  const H = per(hot), W = per(warm), C = per(cold), F = per(freeze);
  const base = { org_id: "o", offer_id: offer, group_id: group };
  const same = {
    cold_sent_14d: C.sent_14d, cold_sent_30d: C.sent_30d, cold_fresh_pool: C.fresh_pool,
    freeze_sent_14d: F.sent_14d, freeze_sent_30d: F.sent_30d, freeze_fresh_pool: F.fresh_pool,
  };
  const old: LifecycleViewRow = {
    ...base, ...same,
    hw_sent_14d: H.sent_14d + W.sent_14d, hw_sent_30d: H.sent_30d + W.sent_30d, hw_fresh_pool: H.fresh_pool + W.fresh_pool,
  };
  const neu: LifecycleViewRow = {
    ...base, ...same,
    hot_sent_14d: H.sent_14d, hot_sent_30d: H.sent_30d, hot_fresh_pool: H.fresh_pool,
    warm_sent_14d: W.sent_14d, warm_sent_30d: W.sent_30d, warm_fresh_pool: W.fresh_pool,
  };
  return { old, neu };
};

const a = cell(1, 10, 5, 7, 11, 13);
const b = cell(1, 20, 2, 0, 3, 1);
const clean = compareLifecycleViews([a.old, b.old], [a.neu, b.neu]);
bar("C1 the faithful split passes every check", clean.ok, JSON.stringify({ lost: clean.lost, nulls: clean.nullCells }));
bar("C2 …and totals reconcile (hot+warm 30d = hw 30d)",
  clean.totals["hot+warm sent_30d vs hw_sent_30d"].old === clean.totals["hot+warm sent_30d vs hw_sent_30d"].neu);

const lost = compareLifecycleViews([a.old, b.old], [a.neu]);
bar("L1 ⭐ a row missing from v2 fails, and is named", !lost.ok && lost.lost.length === 1 && lost.newRows === 1, lost.lost.join());

const nul = compareLifecycleViews([a.old], [{ ...a.neu, warm_fresh_pool: null }]);
bar("N1 ⭐ a NULL cell in v2 fails", !nul.ok && nul.nullCells === 1, `${nul.nullCells}`);

const drift = compareLifecycleViews([a.old, b.old], [{ ...a.neu, hot_sent_30d: Number(a.neu.hot_sent_30d) + 2 }, b.neu]);
bar("D1 ⭐ Hot + Warm ≠ old Hot/Warm on one cell fails, counted as drift with its size",
  !drift.ok && drift.hotWarm.sent_30d.cells === 1 && drift.hotWarm.sent_30d.net === 2 && drift.hotWarm.sent_14d.cells === 0,
  JSON.stringify(drift.hotWarm.sent_30d));

const coldMove = compareLifecycleViews([a.old], [{ ...a.neu, cold_fresh_pool: Number(a.neu.cold_fresh_pool) - 1 }]);
bar("D2 ⭐ a Cold cell that moved fails, on that column only",
  !coldMove.ok && coldMove.same.cold_fresh_pool.cells === 1 && coldMove.same.cold_sent_30d.cells === 0);

const swapped = compareLifecycleViews([a.old], [{ ...a.neu, hot_sent_14d: a.neu.warm_sent_14d, warm_sent_14d: a.neu.hot_sent_14d }]);
bar("S1 (known limit) Hot and Warm swapped still sums right — the SPLIT is proven by the fixture test, not here",
  swapped.ok, "test-offer-group-lifecycle.ts checks every hot/warm cell against an independent computation");

console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
