"use client";

import { AlertTriangle } from "lucide-react";

import {
  buildEventColumns,
  eventCellValue,
  visibleEventTypes,
  type EventColumn,
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
export function eventColsFor(
  spec: readonly EventTypeSpec[],
  rows: ReadonlyArray<{ events?: EventMap }>,
  totals: { events?: EventMap } | null,
  showTierB: boolean,
): EventColumn[] {
  const cols = buildEventColumns(visibleEventTypes(spec, seenMaps(rows, totals)));
  return showTierB ? cols : cols.filter((c) => c.tier === "a");
}

/**
 * How many columns the Event-breakdown toggle GOVERNS.
 *
 * ⭐ IT TAKES NO `showTierB` ARGUMENT, DELIBERATELY. This is a constant of the
 * registry, not of the toggle's current state, and the control's own visibility
 * depends on it: a state-dependent count reads 0 while the toggle is ON, which
 * unmounts the control and leaves tier B switched on with no way to switch it
 * off. Giving the function no way to see the toggle makes that bug
 * unrepresentable rather than merely tested. Bar W12.
 */
export function tierBColumnCount(
  spec: readonly EventTypeSpec[],
  rows: ReadonlyArray<{ events?: EventMap }>,
  totals: { events?: EventMap } | null,
): number {
  return eventColsFor(spec, rows, totals, true).filter((c) => c.tier === "b").length;
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

export { eventCellValue };

/**
 * ⭐ PRIVATE, AND THAT IS THE POINT — see EventColumnsBar.
 *
 * It renders NOTHING when it governs no columns: a checkbox that reveals nothing
 * is a dead control. `count` therefore has to be the registry's constant, which
 * is why tierBColumnCount() cannot see the toggle.
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
 */
export function EventColumnsBar({
  showEvents,
  onShowEventsChange,
  tierBCount,
  unmapped,
}: {
  showEvents: boolean;
  onShowEventsChange: (v: boolean) => void;
  tierBCount: number;
  unmapped: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <EventBreakdownToggle value={showEvents} onChange={onShowEventsChange} count={tierBCount} />
      <UnmappedBadge count={unmapped} />
    </div>
  );
}
