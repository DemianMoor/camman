import { readFileSync, readdirSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import * as view from "@/components/reports/event-columns-view";
import {
  EventColumnsBar,
  EventTotalsTiles,
  StageEventBreakdown,
  eventCellValue,
  eventColumnBlock,
  fmtEventCell,
  sortColumnOrFallback,
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
check(
  "W19 ⭐ the hourly row map contains NO `pending_revenue` override — the scalar is computed, so a zero there is a measurement",
  hourlyRowMap !== undefined &&
    // Positive control: the block really is the hourly row map (it spreads the
    // accumulated metrics), so "no match" cannot pass as "no override".
    hourlyRowMap.includes("...m") &&
    !hourlyRowMap.includes("pending_revenue:") &&
    // …and the series that replaced it is in this file, off the shared clause.
    perfLibSrc.includes("ledgerHourAgg(pendingRevenueClause()"),
  hourlyRowMap === undefined ? "hourly row map not found" : hourlyRowMap.slice(0, 220),
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
const spreadsRaw = [...resultsSrc.matchAll(/\.\.\.withFunnelDerived\(/g)].length;
const spreadsWrapped = [...resultsSrc.matchAll(/\.\.\.withoutEventBreakdown\( withFunnelDerived\(/g)].length;
check(
  `W20 ⭐ every response body in /api/keitaro/results strips the breakdown it never selected (${spreadsWrapped} wrapped, ${spreadsRaw} bare)`,
  spreadsWrapped === 3 && spreadsRaw === 0,
  `wrapped=${spreadsWrapped} bare=${spreadsRaw}`,
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
const stageLine = (unmapped: number, types: EventTypeSpec[] = SPEC, events: EventMap = ROWS[0].events) =>
  renderToStaticMarkup(createElement(StageEventBreakdown, { types, events, unmapped }));

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
// The tiles take the surrounding card's own tile markup through renderTile, so
// what is pinned here is the COMPOSITION — N tiles AND the badge, from one call.
const tiles = (unmapped: number) =>
  renderToStaticMarkup(
    createElement(EventTotalsTiles, {
      types: SPEC,
      events: TOTALS.events,
      unmapped,
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
check(
  "X6 ⭐ no renderer of per-event figures is exported WITHOUT its residual — the stage line and the tiles are the only two, and neither half is reachable alone",
  typeof view.StageEventBreakdown === "function" && // positive control
    typeof view.EventTotalsTiles === "function" &&
    !("UnmappedBadge" in view) &&
    !("StageEventSegments" in view) &&
    !("EventTiles" in view),
  `exports: ${Object.keys(view).join(", ")}`,
);

// ── ⭐ …AND THE CAMPAIGN PAGE MOUNTS THOSE, RATHER THAN ITS OWN COPY ─────────
//
// X6 makes an under-explaining surface unbuildable out of THIS module; this is
// what pins the campaign page to the module. Whitespace-collapsed and needle-
// free of newlines, because this checkout mixes CRLF and LF per file and a
// multi-line needle is an assertion that can never fail.
const campaignPageSrc = readFileSync("app/(protected)/campaigns/[id]/page.tsx", "utf8").replace(/\s+/g, " ");
check(
  "X7 ⭐ the campaign page renders the breakdown through the shared components — it does not roll its own segments or its own badge",
  campaignPageSrc.includes("<StageEventBreakdown") && campaignPageSrc.includes("<EventTotalsTiles"),
  `StageEventBreakdown=${campaignPageSrc.includes("<StageEventBreakdown")} EventTotalsTiles=${campaignPageSrc.includes("<EventTotalsTiles")}`,
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
// out. (The stripper is a local copy: importing the gate's would RUN the gate,
// which exits the process.)
const flatSrc = (p: string) =>
  readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\s+/g, " ");

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
const BUILDERS = ["eventColumnBlock(", "buildEventColumns(", "visibleEventTypes(", "eventColsFor(", "tierBColumnCount("];
// …and it renders the residual if it MOUNTS one of the three components that
// carry it. The module that defines them is excluded from the scan.
const RESIDUAL = ["<EventColumnsBar", "<StageEventBreakdown", "<EventTotalsTiles"];
const VIEW_MODULE = "components/reports/event-columns-view.tsx";

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
];
check(
  `X8 ⭐ the scanner finds the per-event surfaces that exist (${builders.length} of ${scanned.length} files) — a scan that finds nothing must fail HERE, not pass X9`,
  KNOWN_SURFACES.every((p) => builders.includes(p)),
  `found: ${builders.join(", ")}`,
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
  "const cols = eventColsFor(spec, rows, totals, false);",
  "const n = tierBColumnCount(spec, rows, totals);",
];
const RESIDUAL_SAMPLES = [
  "return <EventColumnsBar block={block} onShowEventsChange={f} />;",
  "return <StageEventBreakdown types={t} events={e} unmapped={u} />;",
  "return <EventTotalsTiles types={t} events={e} unmapped={u} renderTile={r} />;",
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
