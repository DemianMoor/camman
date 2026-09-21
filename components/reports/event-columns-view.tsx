"use client";

import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

import {
  addEventMaps,
  buildEventColumns,
  eventCellValue,
  pluralizeLabel,
  visibleEventTypes,
  visibleEventTypesByCount,
  type EventColumn,
  type EventCountMap,
  type EventMap,
  type EventTypeSpec,
} from "@/lib/reporting/event-columns";
import { isDefaultViewEventColumn } from "@/lib/reporting/column-visibility";

// The client half of the generated column set, shared by the Overview tab and
// the five performance tabs so the two tables cannot disagree about what a
// "Registrations" column is.
//
// ⭐ NOTHING IN THIS FILE, OR IN EITHER TABLE, MAY NAME AN EVENT KEY. Every
// header, order and formatting decision comes from the EventTypeSpec[] the API
// returns. scripts/test-reports-no-hardcoded-event-keys.ts is the gate.

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Every EventMap on screen for this response — the rows plus the totals row. */
function seenMaps(
  rows: ReadonlyArray<{ events?: EventMap }>,
  totals: { events?: EventMap } | null,
): EventMap[] {
  const out = rows.map((r) => r?.events ?? {});
  if (totals) out.push(totals.events ?? {});
  return out;
}

/**
 * The columns to render for THIS response.
 *
 * ⭐ PRIVATE. A table gets its columns from eventColumnBlock(), which hands back
 * the bar's numbers in the same object — see there for why.
 *
 * `rows` and `totals` are read only to decide whether an ARCHIVED type still has
 * data on screen (visibleEventTypes) — never to discover which types exist. A
 * type configured with zero conversions still gets a column and reads 0; that is
 * the whole point of generating from the registry.
 *
 * `showTierB` is the operator's per-browser Event-breakdown toggle. Tier B holds
 * only the per-event money columns, each of which duplicates an aggregate column
 * already on screen.
 *
 * `showAllColumns` is the OTHER per-browser toggle — the table's curated default
 * view (lib/reporting/column-visibility.ts). It holds back the tier-A columns
 * that are second-order reads of a number still on screen: the per-type rate and
 * held count. The count and the funnel ratio stay, always, because a split
 * nobody can see is not a split.
 *
 * ⭐ THE TWO TOGGLES ARE ORTHOGONAL AND TIER B IS EXEMPT FROM THE CURATED VIEW.
 * Subjecting the money columns to BOTH would make the Event-breakdown control
 * govern nothing while the table is in its default view — and a control that
 * governs nothing unmounts itself (EventBreakdownToggle's `count === 0` early
 * return), so it would blink in and out as the other toggle moved. Worse, the
 * Overview tab has no curated view at all and would lose the money split
 * outright. So the money columns keep the control they have always had, and the
 * curated view governs exactly the columns the owner named.
 */
function eventColsFor(
  spec: readonly EventTypeSpec[],
  rows: ReadonlyArray<{ events?: EventMap }>,
  totals: { events?: EventMap } | null,
  showTierB: boolean,
  showAllColumns: boolean,
): EventColumn[] {
  const cols = buildEventColumns(visibleEventTypes(spec, seenMaps(rows, totals)));
  const tiered = showTierB ? cols : cols.filter((c) => c.tier === "a");
  if (showAllColumns) return tiered;
  return tiered.filter((c) => c.tier === "b" || isDefaultViewEventColumn(c));
}

/** The generated columns for one response, and the bar that has to sit beside them. */
export interface EventColumnBlock {
  /** The columns to render, honouring the toggle. */
  columns: EventColumn[];
  /** <EventColumnsBar>'s numbers. DERIVED HERE, never assembled by the caller. */
  bar: { showEvents: boolean; tierBCount: number; unmapped: number };
}

/**
 * ⭐ THE ONE WAY TO OBTAIN THE GENERATED COLUMNS, AND IT HANDS BACK THE BAR WITH
 * THEM.
 *
 * Task 5 exported the column builder on its own and left `unmapped` a prop the
 * caller assembled, so a new table could render the breakdown and pass the bar a
 * different number — or never mount it. Both halves now come out of ONE call
 * over ONE `totals` object:
 *
 *   - `bar.unmapped` is read off the SAME `totals` the columns were built from,
 *     so the residual cannot describe a different response than the columns do.
 *   - `bar.tierBCount` is the count of columns the toggle GOVERNS, computed with
 *     a LITERAL `true` rather than `showEvents`. It is a constant of the
 *     registry, not of the toggle's state: a state-dependent count reads 0 while
 *     the toggle is ON, which trips EventBreakdownToggle's `count === 0` early
 *     return, unmounts the control, and leaves tier B switched on with no way to
 *     switch it off. Bar W12 compares the two states and fails if they differ.
 *
 * Mounting the returned bar is the one step left to the caller, and bars X8–X11
 * are what make that step not a matter of memory: any file under app/ or
 * components/ that builds per-event columns must also render one of the three
 * residual-bearing surfaces, discovered by scanning rather than from a list.
 *
 * ⭐ AND THE COLUMN-VISIBILITY TOGGLE DOES NOT REOPEN THAT HOLE. `showAllColumns`
 * reaches `columns` and NOTHING ELSE: `bar` is assembled from `totals` on the
 * lines below, where no toggle state is in scope to read. A curated view can
 * therefore drop generated columns and can never drop — or alter — the count of
 * conversions those columns fail to explain. Bars V1/V2 hold both halves of that
 * across all four toggle states.
 */
export function eventColumnBlock(
  spec: readonly EventTypeSpec[],
  rows: ReadonlyArray<{ events?: EventMap }>,
  totals: { events?: EventMap; unmapped?: number } | null,
  showEvents: boolean,
  showAllColumns: boolean,
): EventColumnBlock {
  return {
    columns: eventColsFor(spec, rows, totals, showEvents, showAllColumns),
    bar: {
      showEvents,
      tierBCount: eventColsFor(spec, rows, totals, true, showAllColumns).filter((c) => c.tier === "b").length,
      unmapped: totals?.unmapped ?? 0,
    },
  };
}

/**
 * The sort column a table should actually use: the persisted id while it is
 * still on screen, otherwise `fallback`.
 *
 * ⭐ IT EXISTS BECAUSE A GENERATED COLUMN ID CAN VANISH. `sortBy` is persisted
 * per browser (usePersistedFilters) and a generated id — `evt:<key>:<kind>` —
 * belongs to a registry row that can be archived, renamed or configured away
 * long after the sort was saved. The id then matches no column: every row reads
 * `undefined`, every comparison ties, and the table renders in whatever order
 * the API returned with no sort indicator anywhere. That is indistinguishable
 * from "this is sorted", which is the one thing it must not look like. Falling
 * back to a column that EXISTS both sorts the rows and puts the arrow where the
 * sort actually is. Bars W22/W23.
 */
export function sortColumnOrFallback(
  columnIds: readonly string[],
  persisted: string,
  fallback: string,
): string {
  return columnIds.includes(persisted) ? persisted : fallback;
}

/**
 * ⭐ NULL RENDERS AS "—", NEVER AS 0.0%. A ratio over a zero denominator is
 * unknown; printing 0.0% invents a fact. eventCellValue is what returns the null.
 *
 * A rate or funnel over 100% is printed as-is: both can legitimately exceed it
 * (a registrant whose click was never scored human is outside the EPC
 * denominator; a purchase can arrive with no preceding registration), and
 * clamping would hide the signal.
 *
 * A COUNT can be fractional: the By Group tab splits every metric across each
 * contact's groups, so it shows up to 2 decimals like every other column there.
 */
export function fmtEventCell(v: number | null, kind: EventColumn["kind"]): string {
  if (v == null) return "—";
  if (kind === "count" || kind === "pending_n") {
    return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (kind === "rate" || kind === "funnel") return `${(v * 100).toFixed(1)}%`;
  return usd.format(v);
}

// Re-exported so a client surface can order/filter the registry and fold the
// per-row maps WITHOUT importing lib/reporting/event-columns directly — one
// definition of "which types are on screen" and of "how two maps add up", shared
// by the report tables and the campaign page.
export { addEventMaps, eventCellValue, visibleEventTypes };

/**
 * ⭐ PRIVATE, AND THAT IS THE POINT — see EventColumnsBar.
 *
 * It renders NOTHING when it governs no columns: a checkbox that reveals nothing
 * is a dead control. `count` therefore has to be the registry's constant, which
 * is why eventColumnBlock() computes it with a literal `true` instead of the
 * toggle's own state.
 */
function EventBreakdownToggle({
  value,
  onChange,
  count,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  count: number;
}) {
  if (count === 0) return null;
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground">
      <input
        type="checkbox"
        className="size-3.5 accent-current"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      Event breakdown
      <span className="text-muted-foreground/70">({count} more columns)</span>
    </label>
  );
}

/**
 * Conversions in THIS range and filter whose tracker type matched no mapping.
 *
 * ⭐ PER PAGE, NOT PER ROW, AND NOT ALL-TIME. Per-row would under-report exactly
 * the rows worth finding (a wholly unresolved conversion has no stage, so it is
 * in no row); all-time would shout at a range that has none. It reads
 * totals.unmapped, which is summed by the same accumulators as every other
 * metric.
 *
 * It renders NOTHING at zero — deliberately. A permanent "0 unmapped" chip is
 * furniture, and furniture is not read on the day it changes.
 *
 * ⭐ NO LINK, because there is nowhere to send anyone: conversion_event_mappings
 * has no admin screen yet (phases 1–4 built the ledger and the registry, not a
 * config page). The title says what to do instead. Give it a href the day that
 * page exists.
 */
function UnmappedBadge({ count }: { count: number }) {
  if (!(count > 0)) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-500"
      title={
        `${count.toLocaleString()} conversion(s) in this range matched no event-type mapping, so they are in ` +
        `NONE of the event columns here. Sales and Revenue may already count them: those resolve event types ` +
        `through a list that is not org-scoped, so a conversion carrying another organisation's event type is ` +
        `inside both while sitting under no key here — which is exactly why the event columns can fall short ` +
        `of Sales and Revenue. ` +
        `Fix: add a conversion_event_mappings row for that offer (or its network) and that tracker type; ` +
        `rows inside the 7-day live window heal on the next poll.`
      }
    >
      <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
      {count.toLocaleString()} unmapped
    </span>
  );
}

/**
 * ⭐ THE ONE CONTROL BOTH TABLES MOUNT, AND THE REASON THE TWO HALVES ABOVE ARE
 * PRIVATE.
 *
 * A screen may NOT present the per-event breakdown as an explanation of Sales
 * without showing the unclassified count beside it. The scalars and the
 * per-event entries legitimately differ: `sales` / `revenue` resolve their flags
 * through non-org-scoped id lists while the entries come from an org-scoped
 * join, so a cross-organisation event type is counted by the SCALAR and placed
 * under no key. It surfaces only as `unmapped`. The invariant the table has to
 * keep honest is
 *
 *     sales = Σ over is_purchase types of events[t].n  +  manual_topup  +  strays
 *
 * and if the breakdown is readable while the stray count is not, the table
 * silently under-explains its own total.
 *
 * Exporting the toggle and the badge as two siblings would leave that to
 * convention — a future tab could mount the toggle alone and nothing would
 * notice. So neither is exported: a surface that wants the toggle takes the
 * badge with it, structurally. Tier A is always rendered, so "the breakdown is
 * shown" is true on every tab, and this bar is mounted unconditionally beside
 * the filters — never inside a `showEvents` branch. Bars W13/W14.
 *
 * ⭐ IT TAKES THE WHOLE BLOCK, NOT FOUR LOOSE NUMBERS. Everything it renders is
 * derived by eventColumnBlock() from the very `totals` the columns were built
 * from; the caller supplies only the change handler, which cannot misstate a
 * figure. Task 5's props let a caller pass `unmapped={0}` beside a breakdown
 * built from a response carrying twelve strays.
 */
export function EventColumnsBar({
  block,
  onShowEventsChange,
}: {
  block: EventColumnBlock;
  onShowEventsChange: (v: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <EventBreakdownToggle
        value={block.bar.showEvents}
        onChange={onShowEventsChange}
        count={block.bar.tierBCount}
      />
      <UnmappedBadge count={block.bar.unmapped} />
    </div>
  );
}

/** The counted events of one type inside one row, formatted. Missing key ⇒ "0". */
const eventCount = (events: EventMap, key: string): string =>
  fmtEventCell(events[key]?.n ?? 0, "count");

/**
 * ⭐ THE BREAKDOWN AND ITS RESIDUALS, AS ONE OBJECT — the campaign page's
 * counterpart to the `totals` object eventColumnBlock() reads.
 *
 * Task 6 took `events`, `unmapped` and the tally as SEPARATE props, so the
 * numbers explaining a line could be assembled by the caller from anywhere —
 * `unmapped={0}` beside a stage carrying twelve strays compiled fine. The report
 * tables fixed the same hole by deriving the bar from the very `totals` the
 * columns were built from; this is that rule at the stage grain. One object, one
 * source, and every field REQUIRED: a caller that has counts has both residuals
 * too, or it does not typecheck.
 */
export interface EventBreakdownSource {
  events: EventMap;
  /** Conversions the ORG-SCOPED registry join could not place. See StageEventBreakdown. */
  unmapped: number;
  /** The part of Sales the operator's manual tally contributed (manualSalesTopup). */
  manual_topup: number;
}

/**
 * ⭐ THE STAGES TABLE'S BREAKDOWN AND ITS RESIDUAL, IN ONE COMPONENT — the
 * campaign page's counterpart to EventColumnsBar, and private for the same
 * reason.
 *
 * The campaign page's Results cell is one dense `·`-joined line, so the split
 * cannot be a column set and the badge cannot sit in a filter bar. What CAN be
 * kept is the property that matters: there is no exported way to render the
 * per-event segments that does not also render BOTH residuals. A stage's `sales`
 * counts a conversion whose event type belongs to another organisation while the
 * org-scoped per-event map places it under NO key, and it is a max() over the
 * operator's manual tally which the tracker-only segments cannot see, so
 *
 *     sales = Σ over is_purchase types of events[t].n  +  manual top-ups  +  strays
 *
 * and a cell that reads "Purchases: 2 · Sales: 5" with nothing else on the line
 * silently under-explains itself. Both markers land immediately after the
 * segments they qualify — beside the numbers they are about, not at the end of a
 * line the eye has already left.
 *
 * Every segment ends with its own `· ` separator, so the caller splices this
 * between two existing segments and an EMPTY registry with no residuals changes
 * the line by exactly nothing.
 *
 * `types` is the registry (filtered by visibleEventTypes for the whole table, so
 * every row carries the same segments in the same order) — NEVER the keys found
 * in `events`. A configured type with no conversions reads 0 here; that is the
 * whole point of generating from the registry.
 *
 * ⭐ ONE `source`, NOT THREE NUMBERS — see EventBreakdownSource.
 */
export function StageEventBreakdown({
  types,
  source,
}: {
  types: readonly EventTypeSpec[];
  source: EventBreakdownSource;
}) {
  return (
    <>
      {types.map((t) => (
        <span key={t.key}>
          {pluralizeLabel(t.label)}: {eventCount(source.events, t.key)} ·{" "}
        </span>
      ))}
      {source.manual_topup > 0 ? (
        <span
          className="text-muted-foreground"
          title={
            `${source.manual_topup.toLocaleString()} of this stage's Sales came from the operator's manual ` +
            `tally rather than the tracker. Sales is max(manual tally, tracker conversions) and the segments ` +
            `above count TRACKER events only, so this is the part of Sales no segment can show.`
          }
        >
          Manual: +{source.manual_topup.toLocaleString()} ·{" "}
        </span>
      ) : null}
      {source.unmapped > 0 ? (
        <span
          className="text-amber-700 dark:text-amber-500"
          title={
            `${source.unmapped.toLocaleString()} conversion(s) on this stage matched no event-type mapping, ` +
            `so they are in none of the segments above. Sales and Revenue may already count them: those ` +
            `resolve event types through a list that is not org-scoped, so a stray carrying another ` +
            `organisation's event type is inside them while sitting under no key here — which is why the ` +
            `segments can fall short of Sales. ` +
            `Fix: add a conversion_event_mappings row for that offer (or its network) and that tracker type.`
          }
        >
          ⚠ {source.unmapped.toLocaleString()} unmapped ·{" "}
        </span>
      ) : null}
    </>
  );
}

// ── ⭐ THE THIRD SHAPE: A COUNT-ONLY COLUMN SET, AND ITS RESIDUAL ────────────
//
// /creatives is a TanStack table whose rows are CREATIVES, not stage-days. It
// cannot mount EventColumnsBar — that bar's toggle governs the per-event MONEY
// columns, and this screen deliberately has none (counts only; the money split
// belongs on the reports' dimension=creative, which has a denominator and a
// range picker). It cannot mount StageEventBreakdown or EventTotalsTiles either:
// one is a `·`-joined line, the other a tile grid, and neither is a column set.
//
// What carries over is the RULE, not the markup: there is no exported way to
// obtain the per-event count columns that does not also hand back BOTH
// residuals. A creative's `sales` counts a conversion whose event type belongs
// to another organisation while the org-scoped map places it under NO key, and
// it is a max() over the operator's manual tally that the tracker-only counts
// cannot see, so
//
//     sales = Σ over is_purchase types of events[t]  +  manual top-ups + strays
//
// and a row reading "Registrations 7 · Purchases 1" beside a Sales column of 5
// under-explains itself exactly as a report table would.

/** One generated column on a count-only surface: a registry type, or a residual. */
export interface EventCountColumn {
  /** `evt:<key>:count` for a type, `evt:unmapped` / `evt:manual_topup` for a residual. Stable. */
  id: string;
  header: string;
  kind: "count" | "unmapped" | "manual_topup";
  /** The registry key a "count" column reads. EMPTY for a residual. */
  eventKey: string;
  /** Cell tooltip — the whole explanation, since there is no room for prose. */
  title: string;
}

/**
 * What a count-only surface's row has to offer: its counts, and BOTH residuals.
 *
 * ⭐ THE RESIDUALS ARE REQUIRED, AND THE TYPE IS THE ONLY THING ENFORCING IT.
 * `unmapped?: number` made the residual detachable BY TYPE: a caller mapping its
 * rows to `{ events }` rendered the counts with no residual column at all,
 * compiled clean, and left every scan bar green — the residual column is emitted
 * only when some row HAS one, so a row shape that cannot carry one silently
 * suppresses it. Required fields make that caller a compile error instead.
 */
export interface EventCountRow {
  events?: EventCountMap;
  unmapped: number;
  manual_topup: number;
}

const MANUAL_TOPUP_COLUMN: EventCountColumn = {
  id: "evt:manual_topup",
  header: "Manual",
  kind: "manual_topup",
  eventKey: "",
  title:
    "Sales on this creative's stages in the same window that came from the " +
    "operator's manual tally rather than the tracker. A stage's Sales is " +
    "max(manual tally, tracker conversions) and the event counts to the left " +
    "are TRACKER ONLY, so this is the part of Sales no event count can explain.",
};

const UNMAPPED_COLUMN: EventCountColumn = {
  id: "evt:unmapped",
  header: "Unmapped",
  kind: "unmapped",
  eventKey: "",
  title:
    "Conversions on this creative's stages in the same window that matched no " +
    "event-type mapping, so they are in NONE of the event counts to the left. " +
    "Sales may already count them: it resolves event types through a list that " +
    "is not org-scoped, so a stray carrying another organisation's event type " +
    "is inside Sales while sitting under no key here — which is why the counts " +
    "can fall short of it. " +
    "Fix: add a conversion_event_mappings row for that offer (or its network) " +
    "and that tracker type.",
};

/**
 * ⭐ THE ONE WAY TO OBTAIN PER-EVENT COUNT COLUMNS, AND IT EMITS BOTH RESIDUAL
 * COLUMNS IN THE SAME ARRAY.
 *
 * `render` exists for the same reason EventTotalsTiles takes `renderTile`: the
 * caller keeps its own markup (a TanStack ColumnDef, here) while the
 * COMPOSITION — which columns, in what order, with the residual among them — is
 * what is shared and pinned. A caller cannot take the counts and drop the
 * residual, because it never sees two lists.
 *
 * `rows` are read ONLY to decide whether an archived type still has data on
 * screen and whether any row carries a residual — NEVER to discover which types
 * exist. An active type configured with zero conversions gets a column and reads
 * 0; that is the whole point of generating from the registry.
 *
 * Each residual column appears only while some row on the page HAS one, the same
 * rule UnmappedBadge renders by: a permanently-0 column is furniture, and
 * furniture is not read on the day it changes. "Only while some row has one" is
 * why EventCountRow's residual fields are REQUIRED rather than optional — a row
 * shape that cannot carry one suppresses the column instead of showing 0.
 *
 * ⭐ `showAllColumns` IS THE TABLE'S CURATED-VIEW TOGGLE, AND IT REACHES EXACTLY
 * ONE OF THESE COLUMNS. The counts are the breakdown itself and are never held
 * back; the manual top-up is an ordinary extra (it explains Sales, but it is not
 * a fault and there is nothing to do about it); and the STRAY COUNT is appended
 * on a line that does not take the flag as an argument and has no way to read
 * it. That is the shape of the invariant rather than a promise about it: hiding
 * the strays while the counts are on screen would leave the table explaining its
 * own Sales column with a decomposition it knows to be short, which is the one
 * thing this module exists to prevent. Bars V6/V7.
 */
export function eventCountColumns<TCol>(
  types: readonly EventTypeSpec[],
  rows: ReadonlyArray<EventCountRow>,
  showAllColumns: boolean,
  render: (col: EventCountColumn) => TCol,
): TCol[] {
  const visible = visibleEventTypesByCount(
    types,
    rows.map((r) => r.events ?? {}),
  );
  const cols: EventCountColumn[] = visible.map((t) => ({
    id: `evt:${t.key}:count`,
    header: pluralizeLabel(t.label),
    kind: "count",
    eventKey: t.key,
    title:
      `${pluralizeLabel(t.label)} attributed to this creative's stages in the last 30 days — ` +
      `the same window as Checkout Rate, and classified by the event-type registry rather than ` +
      `by the tracker's own type name.`,
  }));
  // Registry order, then the residuals in the order they explain the gap:
  // the manual top-up (part of Sales, in no tracker count) and then the strays.
  // The stray column stays LAST — it is the one the operator can act on.
  if (showAllColumns && rows.some((r) => r.manual_topup > 0)) cols.push(MANUAL_TOPUP_COLUMN);
  // ⭐ NO TOGGLE ON THIS LINE, AND NONE MAY BE ADDED. See the doc comment above.
  if (rows.some((r) => r.unmapped > 0)) cols.push(UNMAPPED_COLUMN);
  return cols.map(render);
}

/** A residual column's own field on one row. The counts are read separately. */
const residualOf = (col: EventCountColumn, row: EventCountRow): number =>
  col.kind === "manual_topup" ? row.manual_topup : row.unmapped;

/**
 * The number one generated cell shows. Missing key ⇒ 0 (the type is configured,
 * this creative simply has none), and each residual reads its own field — a
 * caller cannot accidentally render a count column with a residual, or one
 * residual with the other's number.
 */
export function eventCountValue(col: EventCountColumn, row: EventCountRow): number {
  if (col.kind !== "count") return residualOf(col, row);
  return row.events?.[col.eventKey] ?? 0;
}

/**
 * ⭐ THE CAMPAIGN TOTALS ROW'S BREAKDOWN AND ITS RESIDUALS, IN ONE COMPONENT —
 * same rule, same reason, same single `source` as StageEventBreakdown.
 *
 * `renderTile` exists so the tiles keep the surrounding card's own markup
 * (TotalsMetric) instead of this module growing a second tile style: the
 * COMPOSITION is what is shared and pinned, not the pixels. A caller can style
 * its tiles however it likes and still cannot obtain them without the residuals.
 *
 * The manual top-up is a TILE rather than a badge: it is not a warning, it is a
 * component of the Sales tile beside it. It renders only when non-zero, for the
 * same reason the badge does — a permanent "Manual 0" is furniture.
 */
export function EventTotalsTiles({
  types,
  source,
  renderTile,
}: {
  types: readonly EventTypeSpec[];
  source: EventBreakdownSource;
  renderTile: (tile: { key: string; label: string; value: string; title?: string }) => ReactNode;
}) {
  return (
    <>
      {types.map((t) =>
        renderTile({
          key: t.key,
          label: pluralizeLabel(t.label),
          value: eventCount(source.events, t.key),
        }),
      )}
      {source.manual_topup > 0
        ? renderTile({
            key: "__manual_topup__",
            label: "Manual tally",
            value: fmtEventCell(source.manual_topup, "count"),
            title:
              "The part of Sales that came from the operator's manual tally rather than the tracker. " +
              "Sales is max(manual tally, tracker conversions) per stage and the event tiles count " +
              "TRACKER events only, so this is the part of Sales no tile can show.",
          })
        : null}
      <UnmappedBadge count={source.unmapped} />
    </>
  );
}
