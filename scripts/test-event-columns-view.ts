import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import * as view from "@/components/reports/event-columns-view";
import {
  EventColumnsBar,
  EventTotalsTiles,
  StageEventBreakdown,
  eventCellValue,
  eventColumnBlock,
  eventCountColumns,
  eventCountValue,
  fmtEventCell,
  sortColumnOrFallback,
  type EventCountColumn,
  type EventCountRow,
} from "@/components/reports/event-columns-view";
import type { EventMap, EventTypeSpec } from "@/lib/reporting/event-columns";

// PURE — no DB, no env, no browser. Run:
//   npx tsx scripts/test-event-columns-view.ts
//
// ⭐ THE REGISTRY IN THIS TEST IS NOT PRODUCTION'S. Neither `signup` nor
// `deposit` nor `legacy_cpa` exists in any database anywhere. A view layer that
// hard-codes production's keys produces the wrong column list for this fixture
// and cannot be rescued by the seed data.
//
// ⭐ EVERY FIXTURE IS ONE-SIDED. No bar asserts a zero that today's world would
// hand it for free: where a bar expects 0 it expects 0 for a type that shares
// its fixture with types carrying real numbers, so "the generator only emits
// columns for types present in the data" fails it.

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

const T = (key: string, label: string, f: Partial<EventTypeSpec> = {}): EventTypeSpec => ({
  key,
  label,
  display_order: 10,
  is_purchase: false,
  counts_revenue: false,
  is_retarget_signal: false,
  archived: false,
  ...f,
});

const tally = (n: number, pending_n = 0, revenue = 0, pending_revenue = 0) => ({
  n,
  pending_n,
  revenue,
  pending_revenue,
});

// Comments out, whitespace collapsed — the shape every source-scanning bar in
// this file matches against (Y9 on a declaration, X8-X12 on a call). Defined
// ONCE, here, because two copies of a stripper are two things to rot. A needle
// therefore never contains a newline: this checkout mixes CRLF and LF per file
// and a multi-line needle is an assertion that can never fail. (It is a local
// copy of the key gate's stripper rather than an import, because importing that
// module RUNS the gate, which exits the process.)
const stripFlat = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, " ");
const flatSrc = (p: string) => stripFlat(readFileSync(p, "utf8"));
const VIEW_MODULE = "components/reports/event-columns-view.tsx";

// The column set a response yields. eventColumnBlock() is the ONLY way to get
// it — the builder behind this is module-private precisely so a surface cannot
// take the columns and leave the bar (X8–X11).
const eventColsFor = (
  spec: readonly EventTypeSpec[],
  rows: ReadonlyArray<{ events?: EventMap }>,
  totals: { events?: EventMap; unmapped?: number } | null,
  showEvents: boolean,
) => eventColumnBlock(spec, rows, totals, showEvents).columns;

const SPEC: EventTypeSpec[] = [
  T("signup", "Signup", { display_order: 20, is_retarget_signal: true }),
  T("deposit", "Deposit", { display_order: 10, is_purchase: true, counts_revenue: true }),
];
const SPEC_ARCHIVED: EventTypeSpec[] = [
  ...SPEC,
  T("legacy_cpa", "Legacy CPA", { display_order: 30, is_purchase: true, counts_revenue: true, archived: true }),
];

// ⭐ ONE-SIDED: the SIGNAL has data, the PURCHASE type has none. A column set
// discovered from the data would be missing `deposit` entirely.
const ROWS: { events: EventMap; counted_clickers: number }[] = [
  { events: { signup: tally(12, 3) }, counted_clickers: 400 },
  { events: { signup: tally(8, 1) }, counted_clickers: 200 },
];
const TOTALS = { events: { signup: tally(20, 4) }, counted_clickers: 600 };

// ── The generated column set ────────────────────────────────────────────────
check(
  "W1 ⭐ tier B is hidden by default and shown by the toggle",
  eventColsFor(SPEC, ROWS, TOTALS, false).every((c) => c.tier === "a") &&
    eventColsFor(SPEC, ROWS, TOTALS, true).some((c) => c.tier === "b"),
);
check(
  "W2 ⭐ an ACTIVE type with no data still gets its column",
  eventColsFor(SPEC, [{ events: {} }], { events: {} }, false).some((c) => c.eventKey === "deposit"),
);
check(
  "W3 ⭐ an ARCHIVED type with no data does not",
  !eventColsFor(SPEC_ARCHIVED, [{ events: {} }], { events: {} }, false).some((c) => c.eventKey === "legacy_cpa"),
);
check(
  "W4 ⭐ an ARCHIVED type WITH data in the rows does",
  eventColsFor(SPEC_ARCHIVED, [{ events: { legacy_cpa: tally(0, 0, 4) } }], null, false).some(
    (c) => c.eventKey === "legacy_cpa",
  ),
);
check(
  "W5 ⭐ an ARCHIVED type present only in TOTALS is kept (a paginated page can be empty of it)",
  eventColsFor(SPEC_ARCHIVED, [{ events: {} }], { events: { legacy_cpa: tally(1) } }, false).some(
    (c) => c.eventKey === "legacy_cpa",
  ),
);
check("W6 an empty registry yields no columns and does not throw", eventColsFor([], [], null, true).length === 0);
check("W7 a row with a MISSING events field does not throw", eventColsFor(SPEC, [{} as never], null, false).length > 0);

// ── Formatting ──────────────────────────────────────────────────────────────
check("W8 ⭐ null renders as an em dash, not 0.0%", fmtEventCell(null, "rate") === "—" && fmtEventCell(null, "epc") === "—");
check("W9 a rate over 100% is printed, not clamped", fmtEventCell(2.5, "rate") === "250.0%");
check(
  "W10 a funnel ratio is a percentage, a revenue column is USD, a count is an integer",
  fmtEventCell(0.25, "funnel") === "25.0%" && fmtEventCell(12.5, "revenue") === "$12.50" && fmtEventCell(3, "count") === "3",
);
check("W11 ⭐ a fractional count (By Group's split shares) shows up to 2 decimals", fmtEventCell(1.333333, "count") === "1.33");

// ── The toggle's governed count ─────────────────────────────────────────────
//
// ⭐ THE COUNT THE CONTROL RECEIVES IS A CONSTANT OF THE REGISTRY, NOT OF THE
// TOGGLE. If it were computed from the VISIBLE set it would read 0 while the
// toggle is on, EventBreakdownToggle's `count === 0` early return would unmount
// the control, and tier B could be switched on and never off.
//
// ⭐ THE TWO SIDES ARE BUILT FROM DIFFERENT TOGGLE STATES, and that is the whole
// bar. An earlier version compared `tierBColumnCount(…)` with a second call to
// the same function on the same arguments — a tautology that no implementation
// could fail. eventColumnBlock() DOES see `showEvents` (it has to: the columns
// depend on it), so the count's independence is now a property of the code
// rather than of the signature, and this is what holds it: blockOff and blockOn
// differ in exactly that argument.
const blockOff = eventColumnBlock(SPEC, ROWS, TOTALS, false);
const blockOn = eventColumnBlock(SPEC, ROWS, TOTALS, true);
const governedOff = blockOff.bar.tierBCount;
const governedOn = blockOn.bar.tierBCount;
const visibleOff = blockOff.columns;
const visibleOn = blockOn.columns;
check(
  `W12 ⭐ the governed count is the same with the toggle ON and OFF, and is non-zero (${governedOff})`,
  governedOff === governedOn &&
    governedOff === visibleOn.filter((c) => c.tier === "b").length &&
    governedOff > 0 &&
    visibleOff.filter((c) => c.tier === "b").length === 0,
  `off=${governedOff} on=${governedOn} visibleOn.b=${visibleOn.filter((c) => c.tier === "b").length}`,
);

// ── ⭐ THE BADGE CANNOT BE HIDDEN WHILE THE BREAKDOWN IS SHOWN ───────────────
//
// The scalars and the per-event entries legitimately differ: `sales` / `revenue`
// resolve their flags through non-org-scoped id lists while the entries come
// from an org-scoped join, so a cross-organisation event type is counted by the
// SCALAR and placed under no key — it surfaces only as `unmapped`. A screen that
// shows the breakdown without the stray count silently under-explains its own
// total. These bars render the real component and read the real markup.
// ⭐ NOTE WHAT IS *NOT* PASSED: no unmapped count. The bar takes the whole
// block, and the block read the residual off the same `totals` it built the
// columns from — so a caller cannot show a breakdown of one response beside the
// stray count of another, or of none.
const bar = (showEvents: boolean, unmapped: number) =>
  renderToStaticMarkup(
    createElement(EventColumnsBar, {
      block: eventColumnBlock(SPEC, ROWS, { ...TOTALS, unmapped }, showEvents),
      onShowEventsChange: () => {},
    }),
  );

const barOff = bar(false, 7);
const barOn = bar(true, 7);
check(
  "W13 ⭐ with the toggle OFF the breakdown is on screen AND the badge renders the response's OWN stray count",
  visibleOff.length > 0 && barOff.includes("7 unmapped"),
  `cols=${visibleOff.length} markup=${barOff.slice(0, 200)}`,
);
check(
  "W14 ⭐ with the toggle ON the badge still renders — no toggle state can hide it",
  visibleOn.length > 0 && barOn.includes("7 unmapped"),
  `cols=${visibleOn.length} markup=${barOn.slice(0, 200)}`,
);
check(
  "W15 the badge renders NOTHING at zero (a permanent '0 unmapped' chip is furniture)",
  !bar(false, 0).includes("unmapped") && !bar(true, 0).includes("unmapped"),
);
check(
  "W16 ⭐ neither the toggle, the badge, NOR THE COLUMN BUILDER is separately exported — no surface can mount one without the other",
  typeof view.EventColumnsBar === "function" && // positive control: the name check works
    typeof view.eventColumnBlock === "function" &&
    !("EventBreakdownToggle" in view) &&
    !("UnmappedBadge" in view) &&
    !("eventColsFor" in view) &&
    !("tierBColumnCount" in view),
  `exports: ${Object.keys(view).join(", ")}`,
);

// ── ⭐ A ZERO-CONVERSION EVENT TYPE STILL RENDERS A COLUMN READING ZERO ──────
//
// The whole point of generating from the registry: a newly configured type is
// visible and reads 0 rather than vanishing until its first conversion lands.
// One-sided — `signup` carries real numbers in the same fixture.
const zeroCol = eventColsFor(SPEC, ROWS, TOTALS, false).find((c) => c.id === "evt:deposit:count");
const zeroFunnel = eventColsFor(SPEC, ROWS, TOTALS, false).find((c) => c.kind === "funnel");
check(
  "W17 ⭐ a configured type with ZERO conversions still gets a column and it reads 0, beside a type that reads 12",
  zeroCol !== undefined &&
    fmtEventCell(eventCellValue(zeroCol, ROWS[0].events, ROWS[0].counted_clickers), zeroCol.kind) === "0" &&
    fmtEventCell(
      eventCellValue(
        eventColsFor(SPEC, ROWS, TOTALS, false).find((c) => c.id === "evt:signup:count")!,
        ROWS[0].events,
        ROWS[0].counted_clickers,
      ),
      "count",
    ) === "12",
  `zeroCol=${zeroCol?.id}`,
);
check(
  "W18 ⭐ the funnel over a zero-numerator purchase type reads 0.0%, and over a zero DENOMINATOR reads an em dash",
  zeroFunnel !== undefined &&
    fmtEventCell(eventCellValue(zeroFunnel, ROWS[0].events, ROWS[0].counted_clickers), "funnel") === "0.0%" &&
    fmtEventCell(eventCellValue(zeroFunnel, {}, 400), "funnel") === "—",
  `funnel=${zeroFunnel?.id}`,
);

// ── ⭐ HOURLY HAD TWO ANSWERS FOR PENDING MONEY. NOW IT HAS ONE ─────────────
//
// FOUND (Task 5): on the hourly dimension the SCALAR `pending_revenue` was set
// to 0 by hand — "the hourly tab renders no pending column … so this is
// deliberately not computed rather than half-computed" — while
// ledgerHourEventQuery DID compute pending_n and pending_revenue into
// `m.events`, off conversion_events, on the same ce.occurred_at ET hour. One API
// body therefore answered the same question twice: `totals.pending_revenue: 0`
// beside a non-zero `events[k].pending_revenue`, with nothing in the payload to
// tell that 0 from a measured one. Task 5 could only keep the two apart ON
// SCREEN; the body stayed inconsistent.
//
// FIXED HERE, IN THE AGGREGATION LAYER (Task 4 review): getHourlyReport now runs
// a pending series off the same ledger, the same hour bucket and the same shared
// clause family as its approved `revenue` (pendingRevenueClause,
// lib/sale-attribution.ts), and the hard-coded override is gone. The scalar and
// the map agree by construction, so a 0 is now always a measured 0.
//
// ⭐ THIS BAR IS THE SENTINEL'S GRAVESTONE. The substantive proof is R13/R13b in
// scripts/test-report-event-columns-db.ts, which reads a real $40-held hour
// through the real reader. This one is cheap, runs with no database, and fails
// the moment the literal override is put back — which is the single edit that
// would make a not-computed 0 indistinguishable from a real one again.
const perfLibSrc = readFileSync("lib/reporting/performance-report.ts", "utf8").replace(/\s+/g, " ");
// The hourly ROW MAP alone — not the whole file. `ZERO` further up legitimately
// declares `pending_revenue: 0` (it is the zero accumulator, where 0 is the only
// right answer), so a file-wide scan would be permanently red for the wrong
// reason. The block below is the one that used to override the computed figure.
const hourlyRowMap = /const rows: PerfRow\[\] = \[\.\.\.hours\.entries\(\)\](.*?)\}\)\);/.exec(
  perfLibSrc,
)?.[1];
const OVERRIDE_NEEDLE = "pending_revenue:";
check(
  "W19 ⭐ the hourly row map contains NO `pending_revenue` override — the scalar is computed, so a zero there is a measurement",
  hourlyRowMap !== undefined &&
    // Positive control: the block really is the hourly row map (it spreads the
    // accumulated metrics), so "no match" cannot pass as "no override".
    hourlyRowMap.includes("...m") &&
    !hourlyRowMap.includes(OVERRIDE_NEEDLE) &&
    // …and the series that replaced it is in this file, off the shared clause.
    perfLibSrc.includes("ledgerHourAgg(pendingRevenueClause()"),
  hourlyRowMap === undefined ? "hourly row map not found" : hourlyRowMap.slice(0, 220),
);
// ⭐ THE NEGATED HALF OF W19 HAS NO CONTROL OF ITS OWN. `...m` proves the BLOCK
// was found and `ledgerHourAgg(…)` proves the replacement is present, but
// neither touches the needle that does the forbidding — measured 2026-09-19:
// narrowing it to "pending_revenue: 0," left this file at 56/0 while a
// re-inlined override went uncaught. So the needle is fired at a hand-written
// copy of the very line it exists to forbid, in both line endings (the scan
// collapses whitespace first, which is what makes a mid-line needle work at all).
const reInlined = (nl: string) =>
  `const rows: PerfRow[] = [...hours.entries()].map(([h, m]) => ({${nl}  ...m,${nl}  pending_revenue: held.get(h) ?? 0,${nl}}));`;
check(
  `W19b ⭐ …and the ${JSON.stringify(OVERRIDE_NEEDLE)} needle really fires on a re-inlined override, in BOTH line endings`,
  reInlined("\n").replace(/\s+/g, " ").includes(OVERRIDE_NEEDLE) &&
    reInlined("\r\n").replace(/\s+/g, " ").includes(OVERRIDE_NEEDLE) &&
    // …and does NOT fire on the accumulator spread that legitimately stays.
    !"({ ...m })".includes(OVERRIDE_NEEDLE),
);

// ── ⭐ AN ABSENT BREAKDOWN MUST NOT BE EMITTED AS AN EMPTY ONE ──────────────
//
// /api/keitaro/results deliberately does NOT select `events` /
// `unmapped_conversions` (nothing there reads them), but addRowToFunnel folds an
// absent column into an EMPTY map — so every response body carried
// `events: {}`, `unmapped: 0`, which reads as "measured, nothing happened". The
// route now wraps each derived tally in withoutEventBreakdown(), which removes
// the three fields. Asserted on the SOURCE because the handler needs a session
// and a database; the helper's own behaviour is proved purely by F10-F12
// (scripts/test-event-tally-merge.ts).
const resultsSrc = readFileSync("app/api/keitaro/results/route.ts", "utf8").replace(/\s+/g, " ");
const BARE_SPREAD = /\.\.\.withFunnelDerived\(/g;
const WRAPPED_SPREAD = /\.\.\.withoutEventBreakdown\( withFunnelDerived\(/g;
const spreadsRaw = [...resultsSrc.matchAll(BARE_SPREAD)].length;
const spreadsWrapped = [...resultsSrc.matchAll(WRAPPED_SPREAD)].length;
check(
  `W20 ⭐ every response body in /api/keitaro/results strips the breakdown it never selected (${spreadsWrapped} wrapped, ${spreadsRaw} bare)`,
  spreadsWrapped === 3 && spreadsRaw === 0,
  `wrapped=${spreadsWrapped} bare=${spreadsRaw}`,
);
// ⭐ `spreadsRaw === 0` IS A NEGATIVE ASSERTION WEARING A COUNT. The wrapped
// needle has a real control — its count has to be 3 — but the BARE one is only
// ever asserted to find nothing, so a narrowed needle finds nothing for the
// wrong reason and W20 stays green. Measured 2026-09-19: renaming it to
// `withFunnelDerivedX` left this file at 56/0 with a re-bared response body
// invisible. Fired here at a hand-written bare spread, in both line endings.
const bareSpread = (nl: string) => `return NextResponse.json({${nl}  ...withFunnelDerived(tally),${nl}});`;
check(
  "W20b ⭐ …and the BARE-spread needle really fires on a response body that skipped the wrapper, in BOTH line endings",
  [...bareSpread("\n").replace(/\s+/g, " ").matchAll(BARE_SPREAD)].length === 1 &&
    [...bareSpread("\r\n").replace(/\s+/g, " ").matchAll(BARE_SPREAD)].length === 1 &&
    // …and it does NOT fire on the WRAPPED form, which is what makes
    // `spreadsRaw === 0` mean "none were left bare" rather than "the two needles
    // shadow each other".
    [...`return NextResponse.json({ ...withoutEventBreakdown( withFunnelDerived(tally)) });`.matchAll(
      BARE_SPREAD,
    )].length === 0,
);

// ── ⭐ AN ALL-ZERO ENTRY IS NOT DATA ─────────────────────────────────────────
//
// Both producers now FILTER an all-zero per-event entry out — the stage-day
// projection in SQL (lib/keitaro/stage-day-conversions.ts) and the hourly reader
// in JS (getHourlyReport; bar R14) — so a type whose rows in the window were all
// rejected yields no key on either path. The COLUMN set has to agree with that
// for a hand-built or a legacy map too: visibleEventTypes() keys on a non-zero
// FIELD rather than on key presence, so an entry that slipped through as zeros
// still renders nothing. One-sided against W4, where a NON-zero entry does
// resurrect the very same archived type.
check(
  "W21 ⭐ an ARCHIVED type whose only entry is ALL-ZERO gets no column — an emitted key and a filtered-out key must render alike",
  !eventColsFor(SPEC_ARCHIVED, [{ events: { legacy_cpa: tally(0, 0, 0, 0) } }], { events: {} }, true).some(
    (c) => c.eventKey === "legacy_cpa",
  ),
);

// ── ⭐ THE CAMPAIGN PAGE'S TWO SURFACES: SAME RULE, ENFORCED THE SAME WAY ────
//
// The stages table cannot carry a column set or a filter bar — its Results cell
// is one dense `·`-joined line and its totals are a tile grid — so the property
// that survives is the one that matters: THERE IS NO EXPORTED WAY TO RENDER THE
// PER-EVENT FIGURES THAT DOES NOT ALSO RENDER THE UNCLASSIFIED COUNT. A stage's
// `sales` counts a cross-organisation event type that the org-scoped map places
// under no key, so a line reading "Deposits: 2 · Sales: 5" and nothing else
// under-explains itself exactly as a report table would.
const stageLine = (
  unmapped: number,
  types: EventTypeSpec[] = SPEC,
  events: EventMap = ROWS[0].events,
  manual_topup = 0,
) =>
  renderToStaticMarkup(
    createElement(StageEventBreakdown, { types, source: { events, unmapped, manual_topup } }),
  );

const lineWithStray = stageLine(7);
check(
  "X1 ⭐ the stage cell's segments and its residual come out of ONE component — both are in the markup, from one mount",
  lineWithStray.includes("Signups: 12") && lineWithStray.includes("7 unmapped"),
  lineWithStray,
);
check(
  "X2 ⭐ a ZERO-conversion event type still renders a segment reading 0, beside one reading 12",
  lineWithStray.includes("Deposits: 0") && lineWithStray.includes("Signups: 12"),
  lineWithStray,
);
check(
  "X3 the stage marker renders NOTHING at zero, and the segments still do (the residual is the only conditional part)",
  !stageLine(0).includes("unmapped") && stageLine(0).includes("Deposits: 0"),
  stageLine(0),
);
check(
  "X4 ⭐ an EMPTY registry with no strays changes the Results line by exactly nothing — the component is spliced between two existing segments",
  stageLine(0, []) === "",
  JSON.stringify(stageLine(0, [])),
);
// ── ⭐ THE SECOND RESIDUAL, ON THE SAME LINE ────────────────────────────────
//
// `sales` is max(manual tally, tracker) per stage while the segments count
// TRACKER events only, so a hand-entered sale is inside Sales and inside no
// segment. Task 6 showed the strays and not this one, which left the line
// under-explaining itself by a different number than the one it was guarding.
// ONE-SIDED: the fixture carries a top-up of 4 and NO strays, so a bar that
// reads the wrong field cannot be satisfied by the other one.
const lineWithTopup = stageLine(0, SPEC, ROWS[0].events, 4);
check(
  "X4b ⭐ the manual top-up is on the line, from the SAME source object as the counts, with no stray in sight",
  lineWithTopup.includes("Manual: +4") &&
    !lineWithTopup.includes("unmapped") &&
    lineWithTopup.includes("Signups: 12"),
  lineWithTopup,
);
check(
  "X4c ⭐ …and it renders NOTHING at zero, exactly like the stray marker (a permanent 'Manual: +0' is furniture)",
  !stageLine(7).includes("Manual:") && stageLine(7).includes("7 unmapped"),
  stageLine(7),
);
check(
  "X4d ⭐ both residuals at once, each reading its OWN number — 4 manual and 7 strays, never one twice",
  (() => {
    const both = stageLine(7, SPEC, ROWS[0].events, 4);
    return both.includes("Manual: +4") && both.includes("⚠ 7 unmapped") && !both.includes("+7");
  })(),
  stageLine(7, SPEC, ROWS[0].events, 4),
);
// The tiles take the surrounding card's own tile markup through renderTile, so
// what is pinned here is the COMPOSITION — N tiles AND the badge, from one call.
const tiles = (unmapped: number, manual_topup = 0) =>
  renderToStaticMarkup(
    createElement(EventTotalsTiles, {
      types: SPEC,
      source: { events: TOTALS.events, unmapped, manual_topup },
      renderTile: ({ key, label, value }: { key: string; label: string; value: string }) =>
        createElement("div", { key, "data-tile": key }, `${label} ${value}`),
    }),
  );
const tilesWithStray = tiles(4);
check(
  "X5 ⭐ the totals tiles carry the badge with them: one tile per registry type AND the unmapped count, from one mount",
  (tilesWithStray.match(/data-tile=/g) ?? []).length === SPEC.length &&
    tilesWithStray.includes("Signups 20") &&
    tilesWithStray.includes("Deposits 0") &&
    tilesWithStray.includes("4 unmapped"),
  tilesWithStray,
);
// ⭐ …AND THE SECOND RESIDUAL, AS A TILE. ONE-SIDED: 9 manual, no strays — the
// tile cannot be satisfied by the badge's number and vice versa.
const tilesWithTopup = tiles(0, 9);
check(
  "X5b ⭐ the manual top-up is a tile from the SAME mount and the SAME source object, and it reads its own number",
  (tilesWithTopup.match(/data-tile=/g) ?? []).length === SPEC.length + 1 &&
    tilesWithTopup.includes("Manual tally 9") &&
    !tilesWithTopup.includes("unmapped"),
  tilesWithTopup,
);
check(
  "X5c ⭐ …and no such tile at zero, while the registry tiles still render (the residuals are the conditional part)",
  (tiles(0).match(/data-tile=/g) ?? []).length === SPEC.length &&
    !tiles(0).includes("Manual tally") &&
    tiles(0).includes("Signups 20"),
  tiles(0),
);
// ── ⭐ WHAT THE RESIDUAL COPY IS ALLOWED TO SAY ─────────────────────────────
//
// Every one of these tooltips used to tell the reader the strays "count as
// NOTHING — not a sale, not revenue". For the documented cross-organisation
// stray that is FALSE and measured false: `sales` and `revenue` resolve
// is_purchase / counts_revenue through NON-org-scoped id lists while the
// per-event map comes from an org-scoped join, so such a conversion is inside
// the very Sales column the breakdown is explaining (bar T20 of
// scripts/test-telegram-report-metrics.ts: sales=3, Σ purchases=2, 1 stray).
//
// The bar is on the PROPERTY, not on today's wording — a bar quoting the new
// sentence would go green again the day someone "tidied" the old one back. All
// three surfaces at once, because the claim was identical on all three.
const RESIDUAL_COPY = [
  { where: "stage line", text: stageLine(7) },
  { where: "totals badge", text: tiles(4) },
  {
    where: "creatives column",
    // Called directly rather than through countCols(), which is declared with
    // the Y bars further down: a `const` is not hoisted, and reaching it from
    // here is a ReferenceError that ends the run instead of printing a bar.
    text: eventCountColumns(
      SPEC,
      [{ events: { signup: 1 }, unmapped: 2, manual_topup: 0 }],
      (c) => c.title,
    ).join(" "),
  },
];
const lyingCopy = RESIDUAL_COPY.filter(
  ({ text }) =>
    /counted nowhere|count as NOTHING in|not a sale, not revenue/i.test(text) ||
    !/sales/i.test(text),
);
check(
  `X13 ⭐⭐ no residual tooltip claims the strays are counted nowhere, and every one names Sales (${RESIDUAL_COPY.length} surfaces)`,
  lyingCopy.length === 0,
  lyingCopy.map((c) => c.where).join(", "),
);
check(
  "X13b ⭐ …and the detector really fires on the sentence that was there before (positive control)",
  (() => {
    const old =
      "12 conversion(s) on this stage matched no event-type mapping and count as NOTHING here — not a sale, not revenue, not in any segment above.";
    return /counted nowhere|count as NOTHING in|not a sale, not revenue/i.test(old);
  })(),
);
check(
  "X6 ⭐ no renderer of per-event figures is exported WITHOUT its residual — the stage line and the tiles are the only two, and neither half is reachable alone",
  typeof view.StageEventBreakdown === "function" && // positive control
    typeof view.EventTotalsTiles === "function" &&
    !("UnmappedBadge" in view) &&
    !("StageEventSegments" in view) &&
    !("EventTiles" in view),
  `exports: ${Object.keys(view).join(", ")}`,
);

// ── ⭐ THE THIRD SHAPE — A COUNT-ONLY COLUMN SET — KEEPS THE SAME RULE ───────
//
// /creatives is a table of CREATIVES, so the residual can be neither an inline
// `·` segment nor a tile; and it cannot mount EventColumnsBar, whose toggle
// governs per-event MONEY columns this screen deliberately does not have.
// What survives is the property that matters: ONE call hands back the count
// columns AND the residual column, and there is no export that yields either
// half alone. `render` keeps the caller's own markup (a TanStack ColumnDef),
// exactly as EventTotalsTiles' renderTile does.
//
// ⭐ ONE-SIDED: `signup` carries 12 and 8; `deposit` — an ACTIVE, configured
// type — carries nothing at all in these rows. A column set discovered from the
// data instead of the registry loses it, which is Y2.
const COUNT_ROWS: EventCountRow[] = [
  { events: { signup: 12 }, unmapped: 0, manual_topup: 0 },
  { events: { signup: 8 }, unmapped: 3, manual_topup: 0 },
];
const COUNT_ROWS_CLEAN: EventCountRow[] = [
  { events: { signup: 12 }, unmapped: 0, manual_topup: 0 },
  { events: { signup: 8 }, unmapped: 0, manual_topup: 0 },
];
// ⭐ ONE-SIDED THE OTHER WAY: a manual top-up and NO strays, so a bar about the
// second residual cannot be satisfied by the first.
const COUNT_ROWS_TOPUP: EventCountRow[] = [
  { events: { signup: 12 }, unmapped: 0, manual_topup: 0 },
  { events: { signup: 8 }, unmapped: 0, manual_topup: 5 },
];
const countCols = (spec: EventTypeSpec[], rows: EventCountRow[]): EventCountColumn[] =>
  eventCountColumns(spec, rows, (c) => c);

const withStray = countCols(SPEC, COUNT_ROWS);
const noStray = countCols(SPEC, COUNT_ROWS_CLEAN);
check(
  "Y1 ⭐ ONE call yields the count columns AND the residual column — the counts cannot be taken without it, because there is no second list to take",
  withStray.filter((c) => c.kind === "count").length === SPEC.length &&
    withStray.filter((c) => c.kind === "unmapped").length === 1 &&
    withStray.length === SPEC.length + 1 &&
    // …and the residual lands AFTER the segments it qualifies, never adrift at
    // the far end of a table the eye has already left.
    withStray[withStray.length - 1].kind === "unmapped",
  JSON.stringify(withStray.map((c) => `${c.kind}:${c.id}`)),
);
check(
  "Y2 ⭐ a configured type with ZERO conversions still gets a column and it reads 0, beside one reading 12",
  (() => {
    const zero = withStray.find((c) => c.id === "evt:deposit:count");
    const live = withStray.find((c) => c.id === "evt:signup:count");
    return (
      zero !== undefined &&
      live !== undefined &&
      eventCountValue(zero, COUNT_ROWS[0]) === 0 &&
      eventCountValue(live, COUNT_ROWS[0]) === 12
    );
  })(),
  JSON.stringify(withStray.map((c) => c.id)),
);
check(
  "Y3 the residual column appears ONLY while a row on the page has a stray — the counts are unconditional, the residual is the one conditional part",
  noStray.length === SPEC.length &&
    !noStray.some((c) => c.kind === "unmapped") &&
    noStray.some((c) => c.id === "evt:deposit:count"),
  JSON.stringify(noStray.map((c) => c.id)),
);
check(
  "Y4 ⭐ an ARCHIVED type gets a count column only while a row still carries a non-zero count for it — the same rule the report tables use, over bare counts",
  !countCols(SPEC_ARCHIVED, COUNT_ROWS).some((c) => c.id === "evt:legacy_cpa:count") &&
    countCols(SPEC_ARCHIVED, [
      { events: { legacy_cpa: 4 }, unmapped: 0, manual_topup: 0 },
    ]).some((c) => c.id === "evt:legacy_cpa:count") &&
    // …and an entry that is present but ZERO does not resurrect it (W21's rule).
    !countCols(SPEC_ARCHIVED, [
      { events: { legacy_cpa: 0 }, unmapped: 0, manual_topup: 0 },
    ]).some((c) => c.id === "evt:legacy_cpa:count"),
);
check(
  "Y5 ⭐ neither half is separately exported — a surface cannot obtain the count columns without the residual, nor the residual on its own",
  typeof view.eventCountColumns === "function" && // positive control: the name check works
    typeof view.eventCountValue === "function" &&
    !("eventCountResidualColumn" in view) &&
    !("RESIDUAL_COLUMN" in view) &&
    !("eventCountColumnsOnly" in view),
  `exports: ${Object.keys(view).join(", ")}`,
);
check(
  "Y6 ⭐ a count column can never render the stray count, nor the residual a count — each reads its own field",
  (() => {
    // Both looked up, neither asserted non-null: a mutation that drops the
    // residual has to FAIL this bar, not throw out of the suite and take the
    // bars below it with it.
    const zero = withStray.find((c) => c.id === "evt:deposit:count");
    const residual = withStray.find((c) => c.kind === "unmapped");
    if (zero === undefined || residual === undefined) return false;
    const row = COUNT_ROWS[1]; // signup: 8, unmapped: 3, no deposit key
    return (
      eventCountValue(zero, row) === 0 &&
      eventCountValue(residual, row) === 3 &&
      eventCountValue(residual, COUNT_ROWS[0]) === 0
    );
  })(),
);
check(
  "Y7 an EMPTY registry with no strays yields no columns at all — the table is changed by exactly nothing",
  countCols([], COUNT_ROWS_CLEAN).length === 0,
);

// ── ⭐ THE SECOND RESIDUAL ON THE COUNT-ONLY GRAIN ──────────────────────────
//
// /creatives shows Sales = max(manual tally, tracker) while its event counts are
// TRACKER ONLY, and manual sales exist in production today — so the strays alone
// never explained that table's own Sales column.
const withTopup = countCols(SPEC, COUNT_ROWS_TOPUP);
check(
  "Y8 ⭐ the manual top-up rides back in the SAME array as the counts, with no stray column beside it",
  withTopup.filter((c) => c.kind === "manual_topup").length === 1 &&
    withTopup.filter((c) => c.kind === "unmapped").length === 0 &&
    withTopup.length === SPEC.length + 1,
  JSON.stringify(withTopup.map((c) => `${c.kind}:${c.id}`)),
);
check(
  "Y8b ⭐ …it reads its OWN field (5, not the 12 counts or the 0 strays) and the stray column reads the stray",
  (() => {
    const topup = withTopup.find((c) => c.kind === "manual_topup");
    if (topup === undefined) return false;
    return (
      eventCountValue(topup, COUNT_ROWS_TOPUP[1]) === 5 &&
      eventCountValue(topup, COUNT_ROWS_TOPUP[0]) === 0 &&
      // …and on the stray fixture the top-up column is absent while the stray
      // column reads 3: neither residual can ever render the other's number.
      eventCountValue(withStray.find((c) => c.kind === "unmapped")!, COUNT_ROWS[1]) === 3
    );
  })(),
);
check(
  "Y8c ⭐ with BOTH residuals present the stray column stays LAST — the actionable one is where the eye ends",
  (() => {
    const both = countCols(SPEC, [
      { events: { signup: 12 }, unmapped: 2, manual_topup: 6 },
    ]);
    return (
      both.length === SPEC.length + 2 &&
      both[both.length - 1].kind === "unmapped" &&
      both[both.length - 2].kind === "manual_topup"
    );
  })(),
  JSON.stringify(
    countCols(SPEC, [{ events: { signup: 12 }, unmapped: 2, manual_topup: 6 }]).map((c) => c.kind),
  ),
);
check(
  "Y8d neither residual column exists when no row carries one, while the registry columns still do",
  countCols(SPEC, COUNT_ROWS_CLEAN).every((c) => c.kind === "count") &&
    countCols(SPEC, COUNT_ROWS_CLEAN).length === SPEC.length,
);

// ── ⭐ THE RESIDUAL FIELDS ARE REQUIRED, AND THE BAR IS ON THE TYPE ─────────
//
// This one cannot be a runtime assertion, because the hole was not a runtime
// one. With `unmapped?: number`, a caller mapping its rows to `{ events }`
// rendered the counts with NO residual column — the column is emitted only when
// some row HAS one, so a row shape that cannot carry one suppresses it silently
// — and it compiled clean, passed every bar above, and left X8-X12 green. tsc
// cannot fail an optional field, so the DECLARATION is what gets asserted.
//
// Field by field, with controls on the matcher: a bar that scans for a whole
// interface body breaks on a reformat and then reads as "still required".
const viewSrc = flatSrc(VIEW_MODULE);
const countRowBody = /export interface EventCountRow \{([^}]*)\}/.exec(viewSrc)?.[1] ?? "";
const isRequired = (field: string, body: string) =>
  new RegExp(`\\b${field}\\s*:`).test(body) && !new RegExp(`\\b${field}\\s*\\?`).test(body);
check(
  "Y9 ⭐ EventCountRow declares BOTH residuals, and neither is optional — the detachability was a TYPE hole",
  countRowBody !== "" &&
    isRequired("unmapped", countRowBody) &&
    isRequired("manual_topup", countRowBody),
  `body: ${countRowBody.trim()}`,
);
check(
  "Y9b ⭐ …and the matcher really distinguishes the two forms (controls, both line endings)",
  isRequired("unmapped", "events?: EventCountMap; unmapped: number;") &&
    !isRequired("unmapped", "events?: EventCountMap; unmapped?: number;") &&
    isRequired("unmapped", stripFlat("events?: EventCountMap;\r\n  unmapped: number;")) &&
    !isRequired("unmapped", stripFlat("events?: EventCountMap;\r\n  unmapped?: number;")) &&
    isRequired("unmapped", stripFlat("events?: EventCountMap;\n  unmapped: number;")) &&
    !isRequired("unmapped", stripFlat("events?: EventCountMap;\n  unmapped?: number;")),
);

// ── ⭐ …AND THE CAMPAIGN PAGE MOUNTS THOSE, RATHER THAN ITS OWN COPY ─────────
//
// X6 makes an under-explaining surface unbuildable out of THIS module; this is
// what pins the campaign page to the module. Whitespace-collapsed and needle-
// free of newlines, because this checkout mixes CRLF and LF per file and a
// multi-line needle is an assertion that can never fail.
const campaignPageSrc = readFileSync("app/(protected)/campaigns/[id]/page.tsx", "utf8").replace(/\s+/g, " ");
const LOOSE_RESIDUAL_PROP = "unmapped={";
check(
  "X7 ⭐ the campaign page renders the breakdown through the shared components — it does not roll its own segments or its own badge",
  campaignPageSrc.includes("<StageEventBreakdown") && campaignPageSrc.includes("<EventTotalsTiles"),
  `StageEventBreakdown=${campaignPageSrc.includes("<StageEventBreakdown")} EventTotalsTiles=${campaignPageSrc.includes("<EventTotalsTiles")}`,
);
check(
  // ⭐ …AND HANDS EACH ONE A SINGLE SOURCE OBJECT. The residual used to be a
  // caller-assembled prop (`unmapped={u}` beside `events={e}`), so nothing but
  // care stopped a cell explaining one stage's counts with another's stray
  // count. The props now travel together, and the page may not pass either
  // separately — tsc enforces the shape, this pins the CALL SITES so a future
  // `unmapped={…}` prop on a NEW component here is noticed too.
  "X7b ⭐ …and it passes each of them ONE source object, never a loose residual prop",
  campaignPageSrc.includes("<StageEventBreakdown types={shownEventTypes} source={") &&
    campaignPageSrc.includes("<EventTotalsTiles types={shownEventTypes} source={") &&
    !campaignPageSrc.includes(LOOSE_RESIDUAL_PROP),
  campaignPageSrc.includes(LOOSE_RESIDUAL_PROP)
    ? "a loose unmapped={…} prop is back on the page"
    : "one of the two mounts does not pass source={…}",
);
// ⭐ X7b's THIRD CLAUSE IS THE ONLY NEGATED ONE, and the two positive clauses
// beside it control different needles. Measured 2026-09-19: narrowing it to
// `"unmapped={ "` left this file at 56/0 while the loose prop it forbids became
// invisible. Fired here at a hand-written JSX mount, in both line endings.
const looseProp = (nl: string) =>
  `<StageEventBreakdown${nl}  types={shownEventTypes}${nl}  events={e}${nl}  unmapped={u}${nl}/>`;
check(
  `X7c ⭐ …and the ${JSON.stringify(LOOSE_RESIDUAL_PROP)} needle really fires on a loose residual prop, in BOTH line endings`,
  looseProp("\n").replace(/\s+/g, " ").includes(LOOSE_RESIDUAL_PROP) &&
    looseProp("\r\n").replace(/\s+/g, " ").includes(LOOSE_RESIDUAL_PROP) &&
    // …and NOT on the paired form the page really uses, so the bar is one-sided.
    !"<StageEventBreakdown types={t} source={s} />".includes(LOOSE_RESIDUAL_PROP),
);

// ── ⭐ …AND NEITHER CAN A SURFACE NOBODY HAS WRITTEN YET ─────────────────────
//
// X7 pins the ONE campaign page by name, and W16/X6 make an under-explaining
// surface unbuildable out of this module's exports. Both are lists: a NEW table
// that builds the columns straight off lib/reporting/event-columns and renders
// its own cells is in neither, and the no-hardcoded-keys gate passes it happily
// (it reads a fixed FILES list, and a file it has never heard of is not scanned
// at all — measured: a hand-rolled probe reddens X9 and leaves that gate 32/0).
//
// So the surfaces are DISCOVERED, not listed: every .ts/.tsx under app/ and
// components/ that builds per-event columns must also mount one of the two
// components that carry the residual. A new one is required the moment it is
// written, which is what "two-directional" buys over a list.
//
// Comments are stripped first, so a file that merely NAMES a builder in prose is
// not dragged in, and one that names a residual component in prose cannot get
// out. (`stripFlat`/`flatSrc` are defined at the top of this file: Y9 needs them
// too, and a second copy of a stripper is a second thing to rot.)
function walkSources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walkSources(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

// A file BUILDS the per-event figures if it calls any of these. `eventColsFor` /
// `tierBColumnCount` are the names Task 5 exported: they are private now, and
// listing them keeps the scan honest if either is ever exported again.
//
// ⚠️ `visibleEventTypes(` does NOT match `visibleEventTypesByCount(` — the "("
// is part of the needle — so the count-grain primitive is listed in its own
// right. Missing it would leave a surface that filters the registry by counts
// and renders its own cells entirely unclassified.
const BUILDERS = [
  "eventColumnBlock(",
  "buildEventColumns(",
  "visibleEventTypes(",
  "visibleEventTypesByCount(",
  "eventColsFor(",
  "tierBColumnCount(",
  "eventCountColumns(",
];
// …and it renders the residual if it MOUNTS one of the three components that
// carry it. The module that defines them is excluded from the scan.
//
// ⭐ `eventCountColumns(` IS IN BOTH LISTS, DELIBERATELY. It is a builder — it
// generates the count columns — and it is ALSO a residual renderer, because the
// residual column comes back inside the very array it returns and the caller is
// never handed the two separately (Y1/Y5). A file that calls it has therefore
// discharged X9 by construction, which is the strongest form of the rule this
// scan exists to enforce, not an exemption from it.
const RESIDUAL = [
  "<EventColumnsBar",
  "<StageEventBreakdown",
  "<EventTotalsTiles",
  "eventCountColumns(",
];

const scanned = ["app", "components"].flatMap((d) => walkSources(d));
const srcOf = new Map(scanned.map((p) => [p, flatSrc(p)]));
const builders = scanned.filter(
  (p) => p !== VIEW_MODULE && BUILDERS.some((n) => srcOf.get(p)!.includes(n)),
);
const residualLess = builders.filter((p) => !RESIDUAL.some((n) => srcOf.get(p)!.includes(n)));

// POSITIVE CONTROL. Every absence-asserting bar needs one: a scanner pointed at
// the wrong root, or one that stopped matching, finds nothing and X9 then reads
// as a clean bill of health forever. These three surfaces exist today and MUST
// be discovered — if one is legitimately removed, this bar is where that is
// noticed, which is the right place for it.
const KNOWN_SURFACES = [
  "components/reports/keitaro-report.tsx",
  "components/reports/performance-report.tsx",
  "app/(protected)/campaigns/[id]/page.tsx",
  // The count-only grain. It is here for the same reason as the other three:
  // if the creatives table stops being discovered — a renamed call, a rotted
  // needle — that must fail HERE rather than quietly shrink X9's population.
  "app/(protected)/creatives/page.tsx",
];
check(
  `X8 ⭐ the scanner finds the per-event surfaces that exist (${builders.length} of ${scanned.length} files) — a scan that finds nothing must fail HERE, not pass X9`,
  // ⭐ …AND THE CONTROL LIST ITSELF CANNOT SHRINK. X8 is `every()` over
  // KNOWN_SURFACES, so DELETING an entry strengthens nothing and weakens the
  // control silently — measured 2026-09-19: dropping the creatives page left
  // this file at 56/0. The roster is spelled out so removing a surface is a
  // deliberate two-place edit, and every entry must still exist on disk so a
  // rename fails here rather than dropping out of the control.
  KNOWN_SURFACES.length === 4 &&
    KNOWN_SURFACES.every((p) => existsSync(p)) &&
    KNOWN_SURFACES.every((p) => builders.includes(p)),
  `found: ${builders.join(", ")} | known=${KNOWN_SURFACES.length} missing-on-disk=${KNOWN_SURFACES.filter((p) => !existsSync(p)).join(", ") || "none"}`,
);
check(
  "X9 ⭐ every surface that builds per-event columns also mounts a component that renders the residual — discovered by scanning, so a NEW table is covered the day it is written",
  residualLess.length === 0,
  residualLess.length > 0 ? `breakdown without residual: ${residualLess.join(", ")}` : "",
);
// NEGATIVE CONTROLS ON THE CLASSIFIER ITSELF, the same reason G0a–G0h exist in
// the key gate: X9 asserts an ABSENCE, so a needle that stopped matching makes
// it permanently green.
const classify = (src: string) => {
  const s = src.replace(/\s+/g, " ");
  return { builds: BUILDERS.some((n) => s.includes(n)), residual: RESIDUAL.some((n) => s.includes(n)) };
};
const handRolled = classify("const cols = buildEventColumns(visibleEventTypes(t, m));");
const paired = classify("const b = eventColumnBlock(t, r, x, s); return <EventColumnsBar block={b} />;");
const unrelated = classify("export function StatCard({ label }: { label: string }) { return <div>{label}</div>; }");
check(
  "X10 ⭐ the classifier flags a hand-rolled breakdown with no residual, clears a paired one, and ignores a component that builds nothing",
  handRolled.builds &&
    !handRolled.residual &&
    paired.builds &&
    paired.residual &&
    !unrelated.builds &&
    !unrelated.residual,
  JSON.stringify({ handRolled, paired, unrelated }),
);
// ⭐ AND EVERY NEEDLE SEPARATELY, against a HAND-WRITTEN sample of the call it
// names. X10's fixtures each match more than one needle, so a single dead needle
// survives it — measured: renaming `buildEventColumns(` in the list left X8, X9
// and X10 all green. The samples below are written out, never generated from
// BUILDERS/RESIDUAL: a control built out of the thing it controls is a
// tautology, and the whole point is that one list can rot without the other.
const BUILDER_SAMPLES = [
  "const b = eventColumnBlock(spec, rows, totals, showEvents);",
  "const cols = buildEventColumns(types);",
  "const live = visibleEventTypes(spec, maps);",
  "const live = visibleEventTypesByCount(spec, countMaps);",
  "const cols = eventColsFor(spec, rows, totals, false);",
  "const n = tierBColumnCount(spec, rows, totals);",
  "const cols = eventCountColumns(eventTypes, rows, render);",
];
const RESIDUAL_SAMPLES = [
  "return <EventColumnsBar block={block} onShowEventsChange={f} />;",
  "return <StageEventBreakdown types={t} source={s} />;",
  "return <EventTotalsTiles types={t} source={s} renderTile={r} />;",
  // The residual column rides back inside this call's own array.
  "const cols = eventCountColumns(eventTypes, rows, render);",
];
const deadBuilder = BUILDERS.filter((n) => !BUILDER_SAMPLES.some((s) => s.includes(n)));
const deadResidual = RESIDUAL.filter((n) => !RESIDUAL_SAMPLES.some((s) => s.includes(n)));
check(
  `X11 ⭐ every needle in both lists still matches the call it names (${BUILDERS.length} builders, ${RESIDUAL.length} residual renderers)`,
  BUILDER_SAMPLES.every((s) => classify(s).builds) &&
    RESIDUAL_SAMPLES.every((s) => classify(s).residual) &&
    deadBuilder.length === 0 &&
    deadResidual.length === 0,
  `dead builder needles: ${deadBuilder.join(", ") || "none"} | dead residual needles: ${deadResidual.join(", ") || "none"}`,
);
// ⭐ …AND IN BOTH LINE ENDINGS. This checkout mixes CRLF and LF per file
// (core.autocrlf=true; .gitattributes pins only db/migrations/**), so a needle
// that matched only one of them would classify a surface differently depending
// on which machine last touched the file — silently, and in the direction that
// makes X9 pass. The classifier collapses whitespace first, which is what makes
// this true; this bar is what keeps it true, needle BY needle rather than over a
// fixture that several needles happen to share.
const asCrlf = (s: string) => s.replace(/\n/g, "\r\n");
const lineEndingSensitive = [
  ...BUILDER_SAMPLES.map((s) => ({ s, want: "builds" as const })),
  ...RESIDUAL_SAMPLES.map((s) => ({ s, want: "residual" as const })),
].filter(({ s, want }) => {
  // One needle per sample, split onto two lines so the collapse is load-bearing:
  // an un-collapsed match would see "eventCountColumns(\r\n" and miss.
  const split = s.replace(/\(/, "(\n  ");
  return !(classify(split)[want] && classify(asCrlf(split))[want]);
});
check(
  `X12 ⭐ every needle matches across a line break in BOTH line endings (${BUILDER_SAMPLES.length + RESIDUAL_SAMPLES.length} samples, LF and CRLF)`,
  lineEndingSensitive.length === 0 &&
    // Positive control: the split really does put a newline inside the call, so
    // "they all matched" cannot mean "nothing was split".
    BUILDER_SAMPLES[0].replace(/\(/, "(\n  ").includes("(\n"),
  lineEndingSensitive.map(({ s }) => s).join(" | "),
);

// ── ⭐ A PERSISTED SORT THAT NAMES A VANISHED COLUMN MUST FAIL VISIBLY ───────
//
// `sortBy` is persisted per browser while a GENERATED id belongs to a registry
// row that can be archived or configured away. An id matching no column ties
// every comparison: the rows come back in API order with no arrow anywhere,
// which is indistinguishable from a sorted table. One-sided — the fixture holds
// a generated id that IS on screen beside one that is not.
const liveIds = visibleOff.map((c) => c.id);
check(
  `W22 ⭐ an id that matches no column falls back to one that exists (${liveIds.length} live ids)`,
  liveIds.length > 0 &&
    !liveIds.includes("evt:legacy_cpa:count") &&
    sortColumnOrFallback(liveIds, "evt:legacy_cpa:count", "sent") === "sent" &&
    sortColumnOrFallback([], "evt:signup:count", "sent") === "sent",
  `ids=${liveIds.join(",")}`,
);
check(
  "W23 a generated id that IS on screen is kept, not overridden (positive control)",
  sortColumnOrFallback(liveIds, liveIds[0], "sent") === liveIds[0] &&
    sortColumnOrFallback(["sent", "revenue"], "revenue", "sent") === "revenue",
  `first=${liveIds[0]}`,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
