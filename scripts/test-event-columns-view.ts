import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import * as view from "@/components/reports/event-columns-view";
import { EventColumnsBar, eventCellValue, eventColsFor, fmtEventCell, tierBColumnCount } from "@/components/reports/event-columns-view";
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
const governedOff = tierBColumnCount(SPEC, ROWS, TOTALS);
const visibleOff = eventColsFor(SPEC, ROWS, TOTALS, false);
const visibleOn = eventColsFor(SPEC, ROWS, TOTALS, true);
const governedOn = tierBColumnCount(SPEC, ROWS, TOTALS);
check(
  `W12 ⭐ the governed count is the same with the toggle on and off, and is non-zero (${governedOff})`,
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
const bar = (showEvents: boolean, unmapped: number) =>
  renderToStaticMarkup(
    createElement(EventColumnsBar, {
      showEvents,
      onShowEventsChange: () => {},
      tierBCount: governedOff,
      unmapped,
    }),
  );

const barOff = bar(false, 7);
const barOn = bar(true, 7);
check(
  "W13 ⭐ with the toggle OFF the breakdown is on screen AND the badge renders",
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
  "W16 ⭐ the toggle and the badge are not separately exported, so no surface can mount one without the other",
  typeof view.EventColumnsBar === "function" && // positive control: the name check works
    !("EventBreakdownToggle" in view) &&
    !("UnmappedBadge" in view),
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

// ── ⭐ HOURLY HAS TWO ANSWERS FOR PENDING MONEY; ONLY ONE MAY REACH A ROW ────
//
// FOUND: on the hourly dimension the SCALAR `pending_revenue` is set to 0 by
// hand (lib/reporting/performance-report.ts, the hourly row map: "the hourly tab
// renders no pending column … so this is deliberately not computed rather than
// half-computed"), while ledgerHourEventQuery DOES compute pending_n and
// pending_revenue into `m.events`, off conversion_events, bucketed on the same
// ce.occurred_at ET hour as hourly's own sales and revenue.
//
// WHICH IS CORRECT: the per-event map. Its figures are real and on the same time
// basis as the row's other numbers. The scalar's 0 is a NOT-COMPUTED sentinel,
// not a measurement — hourly never ran a pending query at all. So the per-event
// pending columns stay on hourly; hiding a true number to agree with a
// placeholder would be backwards.
//
// WHY THAT IS SAFE TODAY, AND WHY IT NEEDS A BAR: the sentinel is only harmless
// while NO hourly column and no hourly stat card renders the scalar. That
// condition is implicit and one column addition away from being false — at which
// point the same row would carry $0.00 in one column and $40.00 in the next.
// This bar makes the condition explicit. Making the two AGREE would mean
// computing a pending series in the hourly aggregation, which is Task 4's layer,
// not this one — reported upward rather than reached into.
const perfSrc = readFileSync("components/reports/performance-report.tsx", "utf8").replace(/\s+/g, " ");
const colIds = (name: string): string[] => {
  // The source is whitespace-collapsed first, so this tolerates CRLF and LF
  // alike and never matches across a newline it cannot see.
  const block = new RegExp(`const ${name}: Col\\[\\] = \\[(.*?)\\];`).exec(perfSrc);
  if (!block) return [];
  return [...block[1].matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
};
const fullIds = colIds("FULL_COLS");
const hourlyIds = colIds("HOURLY_COLS");
// A scalar pending field on a row — NOT a generated `evt:…:pending_n` id, which
// is computed from the events map and is the figure that is actually right.
const SCALAR_PENDING = /^pending(_|$)/;
check(
  `W19 the column-list extractor works (FULL_COLS ${fullIds.length} ids, HOURLY_COLS ${hourlyIds.length}) and FULL_COLS DOES carry a scalar pending column`,
  fullIds.length > 10 && hourlyIds.length > 5 && fullIds.some((id) => SCALAR_PENDING.test(id)),
  `full=${fullIds.join(",")} hourly=${hourlyIds.join(",")}`,
);
check(
  "W20 ⭐ HOURLY_COLS declares NO scalar pending column — hourly's scalar pending_revenue is a not-computed 0 while its events map carries the real figure, and one row may not answer twice",
  hourlyIds.length > 5 && !hourlyIds.some((id) => SCALAR_PENDING.test(id)),
  `hourly=${hourlyIds.join(",")}`,
);

// ── ⭐ AN ALL-ZERO ENTRY IS NOT DATA ─────────────────────────────────────────
//
// The hourly path emits an all-zero per-event entry where the stage-day
// projection FILTERs the key out entirely (a type whose rows in the hour were
// all rejected). The two must still produce the SAME column set, or hourly would
// show a column of zeros where By Offer shows nothing. visibleEventTypes() keys
// on a non-zero field rather than on key presence, which is what makes them
// agree; this pins it. One-sided against W4, where a NON-zero entry does
// resurrect the very same archived type.
check(
  "W21 ⭐ an ARCHIVED type whose only entry is ALL-ZERO gets no column — an emitted key and a filtered-out key must render alike",
  !eventColsFor(SPEC_ARCHIVED, [{ events: { legacy_cpa: tally(0, 0, 0, 0) } }], { events: {} }, true).some(
    (c) => c.eventKey === "legacy_cpa",
  ),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
