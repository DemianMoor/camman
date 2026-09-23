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
//      was written to keep fixed;
//   5. a null primary sorts LAST in both directions on EVERY kind of column,
//      not only the generated event ones;
//   6. the two source facts no pure fixture can reach — the route sorts the
//      FULL row set before it slices the page, and the By-X tabs' header click
//      runs the same shared cycle Overview does.
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
  // A PLAIN (non-event) numeric column that can go negative and, in S13, be
  // null. `profit` is a real Overview sort id; nothing in the response makes it
  // null today, which is the whole point of S13 — see the note there.
  profit: number | null;
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
    profit: 0,
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

  // ⭐ THIS REPLACED AN ABSENCE REGEX FOR THE LITERAL `* dir` (2026-09-23,
  // review), WHICH ONLY EVER CAUGHT THE ONE SPELLING THE OLD CODE HAPPENED TO
  // USE. The property that matters is not "that literal is gone" but "this
  // component does not order rows itself": every `.sort(` in it must be handed
  // the SHARED comparator. A flip re-hand-rolled as `? cmp : -cmp`, as
  // `(bv - av)`, or as anything else has to replace that argument to take
  // effect, so it goes red HERE, where the old needle stayed green. The list
  // must be NON-EMPTY, so a renamed call site fails the bar rather than
  // emptying it into a vacuous pass.
  const byxSortArgs = [
    ...byx.matchAll(/\.sort\(\s*([A-Za-z_$][\w$]*|[\s\S])/g),
  ].map((m) => m[1]);
  const byxSortsItself =
    byxSortArgs.length === 0 ||
    byxSortArgs.some((arg) => arg !== "makeDimensionComparator");
  // Belt and braces, and the half that survives a sort spelled some other way:
  // no hand-written comparison of two rows anywhere in the file, whichever way
  // round the operands are written, and no post-hoc `.reverse()`.
  const byxHandRollsAComparison =
    /\*\s*dir\b/.test(byx) ||
    /-\s*cmp\b/.test(byx) ||
    /\b[ab]v\s*-\s*[ab]v\b/.test(byx) ||
    /\b[ab]\.\w+\s*-\s*[ab]\.\w+/.test(byx) ||
    /\.reverse\(\)/.test(byx);

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
      !byxSortsItself &&
      !byxHandRollsAComparison &&
      overview.includes('sortCycle="desc-asc"') &&
      wrapper.includes('sortCycle = "asc-desc-clear"') &&
      wrapper.includes("nextSortState(") &&
      // One-sided: each file must still be the file we think it is.
      route.includes("data.sort(") &&
      byx.includes("[...derived].sort(") &&
      consumers.length === 1 &&
      consumers[0] === OVERVIEW,
    `route folds-then-flips: ${routeFoldsThenFlips} | by-x sort args: ${byxSortArgs.join(",") || "NONE FOUND"} | by-x hand-rolled comparison: ${byxHandRollsAComparison} | sortCycle consumers: ${consumers.join(",") || "none"}`,
  );
}

// ---------------------------------------------------------------------------
// 7 · Added by review, 2026-09-23
//
// Numbered AFTER S12 rather than slotted in beside the bars they belong with,
// so the "Bar S12" references in docs/07-conventions.md and docs/CHANGELOG.md
// stay true. Read S13 with the comparator bars (S3–S11) and S14–S15 with the
// wiring bar (S12).
// ---------------------------------------------------------------------------

console.log("\nS13–S15 · the null rule on a plain column, and two source facts");

{
  // ⭐ ONE NULL RULE, NOT TWO. The event branch (S9) and By-X (S10) have always
  // sorted a null LAST in both directions; Overview's PLAIN-column branch used
  // to coerce a missing value with `?? 0`, so the rule docs/07-conventions.md
  // states was false for most of Overview's columns. It is inert in practice —
  // no whitelisted Overview sort id is nullable today — and that is precisely
  // why it needs a bar rather than a note: nothing on screen would have gone
  // wrong until the first nullable column arrived, and then it would have gone
  // wrong quietly, in the direction nobody looks at.
  //
  // ONE-SIDED IN BOTH DIRECTIONS, on purpose. The fixture sorts by `profit`,
  // which can be NEGATIVE, so the two rules disagree either way round:
  //   `?? 0`      desc → c4(9), c3/c2(0), c1(-5) · asc → c1(-5), c3/c2(0), c4
  //   nulls-last  desc → c4(9), c1(-5), c3, c2  · asc → c1, c4, c3, c2
  // A fixture of non-negative values would have passed under the OLD coercion
  // descending and proved nothing.
  const rows: OvRow[] = [
    ov({ campaign_id: 1, profit: -5, clickers: 1 }),
    ov({ campaign_id: 2, profit: null, clickers: 100 }),
    ov({ campaign_id: 3, profit: null, clickers: 200 }),
    ov({ campaign_id: 4, profit: 9, clickers: 2 }),
  ];
  const desc = ovOrder(rows, "profit", "desc");
  const asc = ovOrder(rows, "profit", "asc");
  check(
    "S13 ⭐⭐ a null on a PLAIN Overview column sorts LAST in both directions — the same rule as the event branch and By-X, not `?? 0` — and two nulls are tied, so the Clickers secondary orders them 200 before 100",
    eq(desc, ["c4", "c1", "c3", "c2"]) && eq(asc, ["c1", "c4", "c3", "c2"]),
    `desc ${desc.join(",")} | asc ${asc.join(",")}`,
  );
}

{
  // ⭐⭐ THE REAL HANDLER, EXECUTED — not a regex over it, and not a copy of it.
  // `toggleSort` is lifted out of the component source and run against a
  // stand-in `filters` / `updateFilters` pair, so what this bar exercises is
  // the text that ships. It is the only way to state the By-X CYCLE at all:
  // the old guard was a single absence regex that said nothing about what a
  // click does. A rewrite that still calls the shared function but passes the
  // wrong cycle, or applies the result to the wrong field, fails here.
  //
  // Source is CRLF, so the multi-line needle runs against an LF copy.
  const byxLf = readFileSync(
    "components/reports/performance-report.tsx",
    "utf-8",
  ).replace(/\r\n/g, "\n");
  const m = byxLf.match(/\n  function toggleSort\(([^)]*)\)\s*\{\n([\s\S]*?)\n  \}\n/);
  if (!m) {
    // POSITIVE CONTROL. A needle that stops matching must FAIL, not skip: a
    // silently-unrun bar is the failure mode this whole file exists to avoid.
    check(
      "S14 ⭐⭐ By-X's header click runs the SHARED desc-asc cycle (the real handler, executed)",
      false,
      "could not lift `function toggleSort(…)` out of components/reports/performance-report.tsx — the needle may have gone stale, which is not the same as the behaviour being right",
    );
  } else {
    const params = m[1].replace(/:\s*[\w<>[\]|., ]+/g, "").trim();
    const body = m[2];
    const state: { sortBy: string; sortDir: "asc" | "desc" } = {
      sortBy: "revenue",
      sortDir: "desc",
    };
    const updateFilters = (next: Partial<typeof state>) => {
      Object.assign(state, next);
    };
    const build = new Function(
      "nextSortState",
      "filters",
      "updateFilters",
      `return function toggleSort(${params}) {\n${body}\n};`,
    ) as (
      cycle: typeof nextSortState,
      filters: typeof state,
      update: typeof updateFilters,
    ) => (id: string) => void;
    const toggleSort = build(nextSortState, state, updateFilters);

    const seen: string[] = [];
    const clickAndSnap = (id: string) => {
      toggleSort(id);
      seen.push(`${state.sortBy}/${state.sortDir}`);
    };
    clickAndSnap("sales"); // a fresh column opens DESCENDING
    clickAndSnap("sales"); // the same column flips to ascending
    clickAndSnap("sales"); // and back — the sort is never cleared
    clickAndSnap("cost"); // a fresh column from ASC still opens descending
    const trace = seen.join(" → ");
    check(
      "S14 ⭐⭐ By-X's header click runs the SHARED desc-asc cycle — the real `toggleSort` source, executed: fresh column descending, same column flips, never cleared, and a fresh column from ascending still opens descending",
      trace === "sales/desc → sales/asc → sales/desc → cost/desc" &&
        body.includes("nextSortState(") &&
        body.includes('"desc-asc"'),
      `states: ${trace} | delegates: ${body.includes("nextSortState(")} | cycle named: ${body.includes('"desc-asc"')}`,
    );
  }
}

{
  // ⭐⭐ THE ORDERING CLAIM, PINNED TO THE SOURCE. Overview's Clickers secondary
  // is only right ACROSS PAGES because the route sorts the whole assembled
  // array and cuts the page out of the RESULT. Move the slice above the sort
  // and every other bar in this file still passes — the comparator is
  // unchanged, it is just being applied to twenty rows the primary key already
  // chose. Nothing but the source order can catch that, so the source order is
  // what is asserted.
  const routeSrc = readFileSync("app/api/keitaro/reports/route.ts", "utf-8");
  const SORT_NEEDLE = "data.sort(";
  const SLICE_NEEDLE = ".slice(page * pageSize";
  const sortAt = routeSrc.indexOf(SORT_NEEDLE);
  const sliceAt = routeSrc.indexOf(SLICE_NEEDLE);
  // POSITIVE CONTROL, and the reason this is not a one-line `indexOf <`:
  // `indexOf` answers -1 for a needle that no longer exists, and -1 is less
  // than everything, so a renamed variable would turn the comparison
  // permanently and silently green. Both needles must be present, and present
  // EXACTLY ONCE — two sorts or two slices make "which one" unanswerable.
  const sortCount = routeSrc.split(SORT_NEEDLE).length - 1;
  const sliceCount = routeSrc.split(SLICE_NEEDLE).length - 1;
  check(
    "S15 ⭐⭐ the route sorts the FULL row set BEFORE it slices the page — asserted on source order, with both needles proven present exactly once so a rename cannot pass it vacuously",
    sortCount === 1 &&
      sliceCount === 1 &&
      sortAt >= 0 &&
      sliceAt >= 0 &&
      sortAt < sliceAt,
    `"${SORT_NEEDLE}" at ${sortAt} (${sortCount}×) | "${SLICE_NEEDLE}" at ${sliceAt} (${sliceCount}×)`,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
