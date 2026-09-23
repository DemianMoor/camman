import { readdirSync, readFileSync } from "node:fs";

import {
  makeDimensionComparator,
  makeOverviewComparator,
} from "@/lib/reporting/report-sort";
import { nextSortState } from "@/lib/ui/sort-cycle";

// PURE — no DB, no env, no browser, no network. Run:
//   npx tsx scripts/test-report-sort.ts
//
// Covers the /reports sort rules (docs/07-conventions.md, "Report table sort
// order"):
//   1. a header click sorts DESCENDING first, ASCENDING second, and never
//      clears — on Overview only, because the table wrapper is shared;
//   2. Clickers is a permanent secondary sort, high → low, that never flips;
//   3. a stable third key so identical rows never jitter;
//   4. the direction is applied to the PRIMARY key alone — a tie-break folded
//      in before the flip reverses with the sort, which is the bug this file
//      was written to keep fixed.
//
// ⭐ EVERY FIXTURE IS ONE-SIDED. No bar asserts an order that the pre-change
// comparator would have produced anyway: each tie-break fixture ranks its rows
// one way by Clickers and a DIFFERENT way by every other field on the row
// (input order, id order, counted_clickers), so "the secondary was never
// applied" cannot pass it.

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const eq = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Every .tsx under the given roots, forward-slashed and repo-relative. */
function tsxFiles(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".tsx")) out.push(p);
    }
  };
  roots.forEach(walk);
  return out;
}

// ---------------------------------------------------------------------------
// Overview fixtures
// ---------------------------------------------------------------------------

type OvRow = {
  campaign_id: number;
  stage_id: number | null;
  campaign_name: string;
  clickers: number;
  counted_clickers: number;
  sales: number;
  opt_out_rate: number;
  ev: number | null;
};

let seq = 0;
function ov(p: Partial<OvRow> & { campaign_id: number }): OvRow {
  seq++;
  return {
    stage_id: null,
    campaign_name: `Campaign ${p.campaign_id}`,
    clickers: 0,
    counted_clickers: 0,
    sales: 0,
    opt_out_rate: 0,
    ev: seq, // never null unless a fixture says so
    ...p,
  };
}
const tag = (r: OvRow) =>
  r.stage_id == null ? `c${r.campaign_id}` : `c${r.campaign_id}s${r.stage_id}`;

function ovOrder(
  rows: OvRow[],
  sortBy: string,
  sortDir: "asc" | "desc",
  eventValue: ((r: OvRow) => number | null) | null = null,
): string[] {
  return [...rows]
    .sort(makeOverviewComparator<OvRow>(sortBy, sortDir, eventValue))
    .map(tag);
}

// ---------------------------------------------------------------------------
// 1 · The header-click cycle (lib/ui/sort-cycle.ts)
// ---------------------------------------------------------------------------

console.log("\nS1–S2 · the header-click cycle");

{
  // The DEFAULT cycle backs ~20 registry lists (components/data-table.tsx). It
  // must still be asc → desc → clear, and it must still be what you get when
  // the argument is OMITTED — the wrapper's default is the whole reason the new
  // cycle had to be opt-in.
  const fresh = nextSortState({ sortBy: null, sortDir: "desc" }, "name");
  const second = nextSortState(fresh, "name");
  const third = nextSortState(second, "name");
  const switched = nextSortState({ sortBy: "name", sortDir: "asc" }, "created_at");
  check(
    'S1 ⭐ the DEFAULT cycle (argument omitted) is unchanged: asc → desc → clear, and a fresh column opens ascending',
    fresh.sortBy === "name" &&
      fresh.sortDir === "asc" &&
      second.sortDir === "desc" &&
      third.sortBy === null &&
      switched.sortBy === "created_at" &&
      switched.sortDir === "asc",
    `${JSON.stringify(fresh)} → ${JSON.stringify(second)} → ${JSON.stringify(third)} | switch: ${JSON.stringify(switched)}`,
  );
}

{
  // The /reports cycle. Six clicks on one column, so "it never clears" is
  // asserted past the point the default cycle would have cleared.
  const clicks: { sortBy: string | null; sortDir: "asc" | "desc" }[] = [];
  let state: { sortBy: string | null; sortDir: "asc" | "desc" } = {
    sortBy: "revenue",
    sortDir: "desc",
  };
  for (let i = 0; i < 6; i++) {
    state = nextSortState(state, "sales", "desc-asc");
    clicks.push(state);
  }
  const dirs = clicks.map((c) => c.sortDir).join(",");
  // A fresh column opens descending even when the CURRENT column is ascending —
  // the direction belongs to the click, not to the table.
  const freshFromAsc = nextSortState({ sortBy: "sales", sortDir: "asc" }, "cost", "desc-asc");
  check(
    "S2 ⭐ /reports cycle: first click descending, second ascending, third descending again — and `sortBy` is never cleared over six clicks",
    dirs === "desc,asc,desc,asc,desc,asc" &&
      clicks.every((c) => c.sortBy === "sales") &&
      freshFromAsc.sortBy === "cost" &&
      freshFromAsc.sortDir === "desc",
    `dirs=${dirs} | nulls=${clicks.filter((c) => c.sortBy === null).length} | fresh-from-asc: ${JSON.stringify(freshFromAsc)}`,
  );
}

// ---------------------------------------------------------------------------
// 2 · Clickers as a permanent secondary (the owner's example)
// ---------------------------------------------------------------------------

console.log("\nS3–S7 · Clickers is a permanent secondary that never flips");

// The owner's example: "sorting by Sales puts every campaign with sales first,
// then all the zero-sales campaigns ordered by Clickers".
//
// ONE-SIDED: inside the zero-sales block the Clickers order (4, 3, 5) is
// neither the input order (3, 4, 5) nor campaign_id order nor the
// counted_clickers order (5, 4, 3). Only the Clickers secondary produces it.
const SALES_ROWS: OvRow[] = [
  ov({ campaign_id: 1, sales: 3, clickers: 10, counted_clickers: 999 }),
  ov({ campaign_id: 2, sales: 5, clickers: 20, counted_clickers: 900 }),
  ov({ campaign_id: 3, sales: 0, clickers: 50, counted_clickers: 1 }),
  ov({ campaign_id: 4, sales: 0, clickers: 70, counted_clickers: 2 }),
  ov({ campaign_id: 5, sales: 0, clickers: 30, counted_clickers: 3 }),
  ov({ campaign_id: 6, sales: 3, clickers: 40, counted_clickers: 4 }),
];

{
  const got = ovOrder(SALES_ROWS, "sales", "desc");
  check(
    "S3 ⭐ Sales descending: every campaign with sales first, then the zero-sales campaigns ordered by Clickers high → low",
    eq(got, ["c2", "c6", "c1", "c4", "c3", "c5"]),
    `got ${got.join(",")}`,
  );
}

{
  // ⭐ THE BUG BAR. The primary reverses, the secondary does NOT: the zero-sales
  // block is still 4, 3, 5 — and the sales-3 pair is still 6 before 1. With the
  // tie-break folded in before the direction flip (the old comparator) both
  // blocks come out reversed.
  const got = ovOrder(SALES_ROWS, "sales", "asc");
  check(
    "S4 ⭐⭐ Sales ASCENDING: the primary flips but the Clickers secondary does not — the tied blocks keep the identical high → low order S3 produced",
    eq(got, ["c4", "c3", "c5", "c6", "c1", "c2"]),
    `got ${got.join(",")}`,
  );
}

{
  // Sorting by Clickers itself is just Clickers desc, then the stable key. The
  // ties are two rows of the same campaign, so BOTH stable keys are exercised.
  const rows: OvRow[] = [
    ov({ campaign_id: 1, stage_id: 2, clickers: 5 }),
    ov({ campaign_id: 1, stage_id: 1, clickers: 5 }),
    ov({ campaign_id: 2, stage_id: 1, clickers: 9 }),
  ];
  const desc = ovOrder(rows, "clickers", "desc");
  const asc = ovOrder(rows, "clickers", "asc");
  check(
    "S5 sorting by Clickers itself: Clickers descending, then the stable key ascending — and the stable key does not flip with the direction",
    eq(desc, ["c2s1", "c1s1", "c1s2"]) && eq(asc, ["c1s1", "c1s2", "c2s1"]),
    `desc ${desc.join(",")} | asc ${asc.join(",")}`,
  );
}

{
  // A TEXT primary. Two rows share a name; Clickers breaks the tie the same way
  // in both directions (90 before 10), which is neither input nor id order.
  const rows: OvRow[] = [
    ov({ campaign_id: 1, campaign_name: "Same", clickers: 10 }),
    ov({ campaign_id: 2, campaign_name: "Same", clickers: 90 }),
    ov({ campaign_id: 3, campaign_name: "Alpha", clickers: 5 }),
    ov({ campaign_id: 4, campaign_name: "Zulu", clickers: 1 }),
  ];
  const desc = ovOrder(rows, "campaign_name", "desc");
  const asc = ovOrder(rows, "campaign_name", "asc");
  check(
    "S6 a TEXT primary (campaign_name, localeCompare) keeps the Clickers secondary, identical in both directions",
    eq(desc, ["c4", "c2", "c1", "c3"]) && eq(asc, ["c3", "c2", "c1", "c4"]),
    `desc ${desc.join(",")} | asc ${asc.join(",")}`,
  );
}

{
  // A RATE primary.
  const rows: OvRow[] = [
    ov({ campaign_id: 1, opt_out_rate: 0.02, clickers: 10 }),
    ov({ campaign_id: 2, opt_out_rate: 0.02, clickers: 80 }),
    ov({ campaign_id: 3, opt_out_rate: 0.1, clickers: 1 }),
  ];
  const desc = ovOrder(rows, "opt_out_rate", "desc");
  const asc = ovOrder(rows, "opt_out_rate", "asc");
  check(
    "S7 a RATE primary (opt_out_rate) keeps the Clickers secondary, identical in both directions",
    eq(desc, ["c3", "c2", "c1"]) && eq(asc, ["c2", "c1", "c3"]),
    `desc ${desc.join(",")} | asc ${asc.join(",")}`,
  );
}

// ---------------------------------------------------------------------------
// 3 · The stable third key
// ---------------------------------------------------------------------------

console.log("\nS8–S9 · the stable key, and the unknown rule");

{
  // Rows identical on everything visible. ONE-SIDED THREE WAYS: the expected
  // order is not the input order, not stage_id alone (that would put c2s900
  // last) and not campaign_id alone (the three c7 rows would stay 300, 100,
  // 200). Both keys, in that order, are the only thing that produces it.
  const rows: OvRow[] = [
    ov({ campaign_id: 7, stage_id: 300, clickers: 10, sales: 1 }),
    ov({ campaign_id: 7, stage_id: 100, clickers: 10, sales: 1 }),
    ov({ campaign_id: 7, stage_id: 200, clickers: 10, sales: 1 }),
    ov({ campaign_id: 2, stage_id: 900, clickers: 10, sales: 1 }),
  ];
  const expected = ["c2s900", "c7s100", "c7s200", "c7s300"];
  const desc = ovOrder(rows, "sales", "desc");
  const asc = ovOrder(rows, "sales", "asc");
  check(
    "S8 ⭐ rows identical on primary AND Clickers fall back to campaign_id then stage_id ASCENDING — the same order in both directions",
    eq(desc, expected) && eq(asc, expected),
    `desc ${desc.join(",")} | asc ${asc.join(",")}`,
  );
}

{
  // The event-column rule: a null (unknown ratio) is not a small number.
  const rows: OvRow[] = [
    ov({ campaign_id: 1, ev: 5, clickers: 1 }),
    ov({ campaign_id: 2, ev: null, clickers: 100 }),
    ov({ campaign_id: 3, ev: null, clickers: 200 }),
    ov({ campaign_id: 4, ev: 9, clickers: 2 }),
  ];
  const evOf = (r: OvRow) => r.ev;
  const desc = ovOrder(rows, "evt:x:cr", "desc", evOf);
  const asc = ovOrder(rows, "evt:x:cr", "asc", evOf);
  check(
    "S9 an unknown event value still sorts LAST in both directions — and two unknowns are tied, so the Clickers secondary orders them (200 before 100) rather than input order",
    eq(desc, ["c4", "c1", "c3", "c2"]) && eq(asc, ["c1", "c4", "c3", "c2"]),
    `desc ${desc.join(",")} | asc ${asc.join(",")}`,
  );
}

// ---------------------------------------------------------------------------
// 4 · By-X (components/reports/performance-report.tsx)
// ---------------------------------------------------------------------------

console.log("\nS10 · the By-X tabs");

type DimRow = { key: string; clickers: number; pinned?: boolean; sent: number | null };

{
  const rows: DimRow[] = [
    { key: "manual", clickers: 0, pinned: true, sent: 1 },
    { key: "b", clickers: 10, sent: 5 },
    { key: "a", clickers: 30, sent: 5 },
    { key: "c", clickers: 30, sent: 5 },
    { key: "d", clickers: 99, sent: 2 },
    { key: "e", clickers: 50, sent: null },
  ];
  const order = (dir: "asc" | "desc") =>
    [...rows]
      .sort(makeDimensionComparator<DimRow>(dir, false, (r) => r.sent))
      .map((r) => r.key);
  const desc = order("desc");
  const asc = order("asc");
  check(
    "S10 ⭐ By-X: the pinned Manual row stays first, unknown stays last, and the tied `sent: 5` block is Clickers-desc then key-ascending (a, c, b) in BOTH directions",
    eq(desc, ["manual", "a", "c", "b", "d", "e"]) &&
      eq(asc, ["manual", "d", "a", "c", "b", "e"]),
    `desc ${desc.join(",")} | asc ${asc.join(",")}`,
  );
}

// ---------------------------------------------------------------------------
// 5 · The metric the secondary reads
// ---------------------------------------------------------------------------

console.log("\nS11 · the secondary reads `clickers`, not `counted_clickers`");

{
  // ⭐ THE SILENT-FAILURE BAR. `clickers` is visit_clicks_clean (the column
  // headed `Clickers`); `counted_clickers` is the deduplicated EPC denominator,
  // a different number sitting on the same row. Reading the wrong one still
  // produces a sorted table — just sorted by something nobody can see. This
  // fixture ranks the three rows in the EXACT OPPOSITE order by the two fields,
  // and asserts both that the right order came out and that the two orders
  // really do differ (so the bar cannot pass vacuously).
  const rows: OvRow[] = [
    ov({ campaign_id: 1, sales: 0, clickers: 10, counted_clickers: 300 }),
    ov({ campaign_id: 2, sales: 0, clickers: 20, counted_clickers: 200 }),
    ov({ campaign_id: 3, sales: 0, clickers: 30, counted_clickers: 100 }),
  ];
  const byClickers = ["c3", "c2", "c1"];
  const byCounted = ["c1", "c2", "c3"];
  const desc = ovOrder(rows, "sales", "desc");
  const asc = ovOrder(rows, "sales", "asc");
  check(
    "S11 ⭐⭐ the Clickers secondary follows `clickers` (visit_clicks_clean), not `counted_clickers` — the fixture ranks the rows in opposite orders by the two fields",
    eq(desc, byClickers) && eq(asc, byClickers) && !eq(byClickers, byCounted),
    `desc ${desc.join(",")} | asc ${asc.join(",")} | counted-order would be ${byCounted.join(",")}`,
  );
}

// ---------------------------------------------------------------------------
// 6 · The wiring (source guard)
// ---------------------------------------------------------------------------

console.log("\nS12 · the wiring");

{
  const ROUTE = "app/api/keitaro/reports/route.ts";
  const BYX = "components/reports/performance-report.tsx";
  const OVERVIEW = "components/reports/keitaro-report.tsx";
  const WRAPPER = "components/data-table.tsx";
  const route = readFileSync(ROUTE, "utf-8");
  const byx = readFileSync(BYX, "utf-8");
  const overview = readFileSync(OVERVIEW, "utf-8");
  const wrapper = readFileSync(WRAPPER, "utf-8");

  // A pure comparator that nothing calls is worth nothing, and a tie-break is
  // only fixed if the old "negate the whole comparison" line is GONE.
  const routeFoldsThenFlips = /sortDir === "asc" \? cmp : -cmp/.test(route);
  const byxFlipsInline = /\*\s*dir\b/.test(byx);

  // Every OTHER screen must still be on the default cycle. Scanning the tree
  // for the prop by name rather than trusting the default's declaration: a
  // second consumer opting in is exactly the regression this guards.
  const consumers = tsxFiles(["app", "components"])
    .filter((f) => f !== WRAPPER && readFileSync(f, "utf-8").includes("sortCycle"))
    .sort();

  check(
    "S12 the wiring: both comparators delegate to lib/reporting/report-sort.ts, neither still negates a folded tie-break, Overview opts into the new cycle and the wrapper's default is unchanged",
    route.includes("makeOverviewComparator") &&
      !routeFoldsThenFlips &&
      byx.includes("makeDimensionComparator") &&
      !byxFlipsInline &&
      overview.includes('sortCycle="desc-asc"') &&
      wrapper.includes('sortCycle = "asc-desc-clear"') &&
      wrapper.includes("nextSortState(") &&
      // One-sided: each file must still be the file we think it is.
      route.includes("data.sort(") &&
      byx.includes("[...derived].sort(") &&
      consumers.length === 1 &&
      consumers[0] === OVERVIEW,
    `route folds-then-flips: ${routeFoldsThenFlips} | by-x inline flip: ${byxFlipsInline} | sortCycle consumers: ${consumers.join(",") || "none"}`,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
