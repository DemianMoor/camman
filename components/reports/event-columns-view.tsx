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
 * `showTierB` is the operator's per-browser toggle. Tier A — a count, a rate and
 * a held count per type, plus the signal→purchase ratio — is ALWAYS on, because
 * a split nobody can see is not a split. Tier B holds only the per-event money
 * columns, each of which duplicates an aggregate column already on screen.
 */
function eventColsFor(
  spec: readonly EventTypeSpec[],
  rows: ReadonlyArray<{ events?: EventMap }>,
  totals: { events?: EventMap } | null,
  showTierB: boolean,
): EventColumn[] {
  const cols = buildEventColumns(visibleEventTypes(spec, seenMaps(rows, totals)));
  return showTierB ? cols : cols.filter((c) => c.tier === "a");
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
 */
export function eventColumnBlock(
  spec: readonly EventTypeSpec[],
  rows: ReadonlyArray<{ events?: EventMap }>,
  totals: { events?: EventMap; unmapped?: number } | null,
  showEvents: boolean,
): EventColumnBlock {
  return {
    columns: eventColsFor(spec, rows, totals, showEvents),
    bar: {
      showEvents,
      tierBCount: eventColsFor(spec, rows, totals, true).filter((c) => c.tier === "b").length,
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
        `${count.toLocaleString()} conversion(s) in this range matched no event-type mapping, so they count as ` +
        `NOTHING in any column here — not a sale, not revenue, not in any event column. ` +
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
 * ⭐ THE STAGES TABLE'S BREAKDOWN AND ITS RESIDUAL, IN ONE COMPONENT — the
 * campaign page's counterpart to EventColumnsBar, and private for the same
 * reason.
 *
 * The campaign page's Results cell is one dense `·`-joined line, so the split
 * cannot be a column set and the badge cannot sit in a filter bar. What CAN be
 * kept is the property that matters: there is no exported way to render the
 * per-event segments that does not also render the unclassified count. A stage's
 * `sales` counts a conversion whose event type belongs to another organisation
 * while the org-scoped per-event map places it under NO key, so
 *
 *     sales = Σ over is_purchase types of events[t].n  +  manual top-ups  +  strays
 *
 * and a cell that reads "Purchases: 2 · Sales: 5" with nothing else on the line
 * silently under-explains itself. The marker lands immediately after the
 * segments it qualifies — beside the numbers it is about, not at the end of a
 * line the eye has already left.
 *
 * Every segment ends with its own `· ` separator, so the caller splices this
 * between two existing segments and an EMPTY registry changes the line by
 * exactly nothing.
 *
 * `types` is the registry (filtered by visibleEventTypes for the whole table, so
 * every row carries the same segments in the same order) — NEVER the keys found
 * in `events`. A configured type with no conversions reads 0 here; that is the
 * whole point of generating from the registry.
 */
export function StageEventBreakdown({
  types,
  events,
  unmapped,
}: {
  types: readonly EventTypeSpec[];
  events: EventMap;
  unmapped: number;
}) {
  return (
    <>
      {types.map((t) => (
        <span key={t.key}>
          {pluralizeLabel(t.label)}: {eventCount(events, t.key)} ·{" "}
        </span>
      ))}
      {unmapped > 0 ? (
        <span
          className="text-amber-700 dark:text-amber-500"
          title={
            `${unmapped.toLocaleString()} conversion(s) on this stage matched no event-type mapping and ` +
            `count as NOTHING here — not a sale, not revenue, not in any segment above. ` +
            `Fix: add a conversion_event_mappings row for that offer (or its network) and that tracker type.`
          }
        >
          ⚠ {unmapped.toLocaleString()} unmapped ·{" "}
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
// obtain the per-event count columns that does not also hand back the residual.
// A creative's `sales` counts a conversion whose event type belongs to another
// organisation while the org-scoped map places it under NO key, so
//
//     sales = Σ over is_purchase types of events[t]  +  manual top-ups + strays
//
// and a row reading "Registrations 7 · Purchases 1" beside a Sales column of 5
// under-explains itself exactly as a report table would.

/** One generated column on a count-only surface: a registry type, or the residual. */
export interface EventCountColumn {
  /** `evt:<key>:count` for a type, `evt:unmapped` for the residual. Stable. */
  id: string;
  header: string;
  kind: "count" | "unmapped";
  /** The registry key a "count" column reads. EMPTY for the residual. */
  eventKey: string;
  /** Cell tooltip — the whole explanation, since there is no room for prose. */
  title: string;
}

/** What a count-only surface's row has to offer: its counts, and its strays. */
export interface EventCountRow {
  events?: EventCountMap;
  unmapped?: number;
}

const RESIDUAL_COLUMN: EventCountColumn = {
  id: "evt:unmapped",
  header: "Unmapped",
  kind: "unmapped",
  eventKey: "",
  title:
    "Conversions on this creative's stages in the same window that matched no " +
    "event-type mapping. They count as NOTHING in the columns to the left — not " +
    "a sale, not revenue, not in any event count — so the counts and Sales do " +
    "not add up while this is non-zero. Fix: add a conversion_event_mappings row " +
    "for that offer (or its network) and that tracker type.",
};

/**
 * ⭐ THE ONE WAY TO OBTAIN PER-EVENT COUNT COLUMNS, AND IT EMITS THE RESIDUAL
 * COLUMN IN THE SAME ARRAY.
 *
 * `render` exists for the same reason EventTotalsTiles takes `renderTile`: the
 * caller keeps its own markup (a TanStack ColumnDef, here) while the
 * COMPOSITION — which columns, in what order, with the residual among them — is
 * what is shared and pinned. A caller cannot take the counts and drop the
 * residual, because it never sees two lists.
 *
 * `rows` are read ONLY to decide whether an archived type still has data on
 * screen and whether any row carries a stray — NEVER to discover which types
 * exist. An active type configured with zero conversions gets a column and reads
 * 0; that is the whole point of generating from the registry.
 *
 * The residual column appears only while some row on the page HAS one, the same
 * rule UnmappedBadge renders by: a permanently-0 column is furniture, and
 * furniture is not read on the day it changes.
 */
export function eventCountColumns<TCol>(
  types: readonly EventTypeSpec[],
  rows: ReadonlyArray<EventCountRow>,
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
  if (rows.some((r) => (r.unmapped ?? 0) > 0)) cols.push(RESIDUAL_COLUMN);
  return cols.map(render);
}

/**
 * The number one generated cell shows. Missing key ⇒ 0 (the type is configured,
 * this creative simply has none), and the residual reads its own field — a
 * caller cannot accidentally render a count column with the stray count.
 */
export function eventCountValue(col: EventCountColumn, row: EventCountRow): number {
  if (col.kind === "unmapped") return row.unmapped ?? 0;
  return row.events?.[col.eventKey] ?? 0;
}

/**
 * ⭐ THE CAMPAIGN TOTALS ROW'S BREAKDOWN AND ITS RESIDUAL, IN ONE COMPONENT —
 * same rule, same reason as StageEventBreakdown.
 *
 * `renderTile` exists so the tiles keep the surrounding card's own markup
 * (TotalsMetric) instead of this module growing a second tile style: the
 * COMPOSITION is what is shared and pinned, not the pixels. A caller can style
 * its tiles however it likes and still cannot obtain them without the badge.
 */
export function EventTotalsTiles({
  types,
  events,
  unmapped,
  renderTile,
}: {
  types: readonly EventTypeSpec[];
  events: EventMap;
  unmapped: number;
  renderTile: (tile: { key: string; label: string; value: string }) => ReactNode;
}) {
  return (
    <>
      {types.map((t) =>
        renderTile({ key: t.key, label: pluralizeLabel(t.label), value: eventCount(events, t.key) }),
      )}
      <UnmappedBadge count={unmapped} />
    </>
  );
}
