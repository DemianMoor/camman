"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart3 } from "lucide-react";

import { ProviderPhoneCell } from "@/components/provider-phone-cell";
import {
  EventColumnsBar,
  eventCellValue,
  eventColumnBlock,
  fmtEventCell,
  sortColumnOrFallback,
  type EventColumnBlock,
} from "@/components/reports/event-columns-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CAMPAIGN_TIMEZONE_LABEL, formatCampaignDateTime } from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { REPORTS_EXTRA_COLUMN_IDS } from "@/lib/reporting/column-visibility";
import type { EventColumn, EventTypeSpec } from "@/lib/reporting/event-columns";
import type {
  PerfMetrics,
  PerfRow,
  ProviderOption,
} from "@/lib/reporting/performance-report";
import { makeDimensionComparator } from "@/lib/reporting/report-sort";
import { DIMENSION_LABEL, type ReportDimension } from "@/lib/reporting/report-dimensions";
import { FROZEN_FIRST_COLUMN_CELL } from "@/lib/ui/frozen-column";

interface PerfResponse {
  dimension: ReportDimension;
  data: PerfRow[];
  totals: PerfMetrics;
  refreshedAt: string | null;
  providers: ProviderOption[];
  // The event-type registry. The per-event columns are GENERATED from it, so an
  // empty array simply means no event columns — never a broken table.
  event_types: EventTypeSpec[];
  range: { from: string; to: string; timezone: string };
}

interface DerivedRow extends PerfRow {
  opt_out_rate: number; // opt_outs / sent
  click_rate: number; // clickers / sent (CR)
  redirect_rate: number; // redirects / clickers
  sales_cr: number; // sales / redirects
  epc: number; // PERIOD: revenue / counted clickers in the selected range
  lifetime_epc: number; // LIFETIME: all-time revenue / all-time counted clickers
  profit: number; // revenue - cost
}

type PerfFilters = {
  from: string;
  to: string;
  providerPhoneId: number | null;
  sortBy: string;
  sortDir: "asc" | "desc";
  // Per-browser, off by default — the same mechanism as the campaigns list's
  // tracking-ID toggle. It governs ONLY the per-event money columns (tier B),
  // each of which duplicates an aggregate column already on screen. Everything
  // the owner named is visible without it.
  showEvents: boolean;
  // The CURATED DEFAULT VIEW's toggle, also per-browser and also off by default.
  // This table is 25 columns / 2069px inside a 1126px container; the default
  // view is the 15 the owner named, and this reveals the other 10. See
  // lib/reporting/column-visibility.ts for which and why. It is ORTHOGONAL to
  // showEvents — the per-event money columns keep their own control.
  showAllColumns: boolean;
};

function etDate(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// The initial sort AND the fallback when a persisted sortBy names a column this
// response has no column for. It is on every dimension's column list, hourly
// included, which is what makes it safe as a fallback.
const DEFAULT_SORT_BY = "sent";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const fmtUsd = (n: number) => usd.format(n);
const fmtInt = (n: number) => n.toLocaleString();
// Group rows carry fractional splits — show up to 2 decimals, trimming zeros.
const fmtNum = (n: number) =>
  Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
const rate = (num: number, denom: number) => (denom > 0 ? num / denom : 0);

function derive(r: PerfRow): DerivedRow {
  return {
    ...r,
    opt_out_rate: rate(r.opt_outs, r.sent),
    click_rate: rate(r.clickers, r.sent),
    redirect_rate: rate(r.redirects, r.clickers),
    sales_cr: rate(r.sales, r.redirects),
    epc: rate(r.revenue, r.counted_clickers),
    // Lifetime ignores the date filter entirely and is the PRIMARY figure. It is
    // NOT derivable from the period numbers — counted clickers are deduplicated
    // and so not additive over time.
    lifetime_epc: rate(r.lifetime_revenue, r.lifetime_clickers),
    profit: r.revenue - r.cost,
  };
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {hint ? <div className="text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

type Col = {
  // `string`, not `keyof DerivedRow`: a GENERATED id is not a row key.
  id: string;
  header: string;
  kind: "count" | "pct" | "usd" | "profit" | "event";
  muted?: boolean;
  /** Rendered as the header's tooltip. */
  title?: string;
  /** Set for a GENERATED column; its value is COMPUTED, not read off the row. */
  event?: EventColumn;
};
// Full metric set for number/offer/sequence/group — mirrors the Overview tab.
// BY-GROUP EXEMPTION, surfaced in the UI rather than left silent.
//
// Every other dimension deduplicates its clicker count at the row's own grain.
// By Group cannot: its metrics are FRACTIONALLY SPLIT across each contact's
// groups (a contact in 3 used groups contributes ⅓ to each), and a fractional
// share has no set to take a DISTINCT over. Its click counts are therefore split
// SUMS and are not comparable with the other tabs — so the header says so.
const GROUP_CLICKS_NOTE =
  "By Group only: click counts are fractional shares split across each contact's groups, not deduplicated people. Not comparable with the other tabs.";

// Why Sales does not equal the sum of the purchase columns beside it. Said on
// the column AND on the stat card, because whichever one is read first is the
// one that has to explain itself.
const SALES_NOTE =
  "Tracker conversions plus the manual tally. The per-event columns count tracker events only, so they sum to Sales minus the manual top-up (and minus any unmapped conversions, which the amber badge counts).";

const FULL_COLS: Col[] = [
  { id: "sent", header: "Sent", kind: "count" },
  { id: "opt_outs", header: "Opt-outs", kind: "count", muted: true },
  { id: "opt_out_rate", header: "OptOut %", kind: "pct", muted: true },
  // ⭐ `Landing visits`, NOT `Clickers` (owner, 2026-09-20) — the rename that
  // defuses the trap flagged the same day. The column is
  // `s.tally.visit_clicks_clean`: Keitaro's clean landing-page VISITS,
  // bot-filtered by KEITARO, never human-scored by CamMan, and explicitly
  // display-only (lib/keitaro/poll.ts, PerfMetrics in
  // lib/reporting/performance-report.ts). It is NOT the EPC denominator —
  // that is `Human clicks` (counted_clickers) further right. The old header was
  // a people-word over a visit count sitting four columns from the real
  // denominator; `landing` separates it from `Redirects`, and `visits` stops it
  // claiming to be people.
  //
  // ⭐ THE COLUMN `id` DELIBERATELY DID NOT MOVE. Sorts persist by id
  // (usePersistedFilters stores `sortBy: "clickers"`) and the Operator API
  // ships the field as `clickers`, so renaming the HEADER changed neither a
  // saved sort nor a contract. Do not "tidy" the id to match the label.
  // Do not spell "human" here — V23. Bars V13/V24 pin the new header.
  //
  // ⭐ OVERVIEW HEADS THIS SAME METRIC `Clickers` SINCE 2026-09-23, AND THAT
  // DIVERGENCE IS THE OWNER'S DECISION, NOT DRIFT. "One metric, one name" was
  // right while both tabs showed the same columns: the danger was a people-word
  // sitting four columns from `Human clicks`, the real EPC denominator, on a
  // table that carried both. Overview no longer carries EITHER human-click
  // column — they were removed from it in the same change — so nothing there
  // can be mistaken for the denominator and the shorter name is unambiguous on
  // that tab alone. THIS table still shows `Human clicks` two columns down, so
  // the trap is live here and `Landing visits` stays. ⚠️ Do NOT "restore
  // consistency" by renaming either side: bar V24 pins each tab's header AND
  // that neither string appears on the other.
  { id: "clickers", header: "Landing visits", kind: "count" },
  { id: "click_rate", header: "CR %", kind: "pct", muted: true },
  { id: "redirects", header: "Redirects", kind: "count" },
  { id: "redirect_rate", header: "Redir %", kind: "pct", muted: true },
  { id: "sales", header: "Sales", kind: "count", title: SALES_NOTE },
  { id: "sales_cr", header: "Sales CR", kind: "pct", muted: true },
  { id: "revenue", header: "Revenue", kind: "usd" },
  { id: "pending_revenue", header: "Pending $", kind: "usd", muted: true },
  { id: "cost", header: "Cost", kind: "usd", muted: true },
  // LIFETIME first — it is the primary figure and ignores the date filter.
  // Each EPC sits immediately after the count it divided by: a $0.00 EPC is only
  // interpretable when you can see the denominator was 4.
  //
  // ⭐ THE RANGED PAIR IS UNSUFFIXED, AND HERE IS WHY THAT IS SAFE RATHER THAN
  // JUST PERMITTED (owner, 2026-09-20: "the page has a date filter; the suffix
  // is redundant"). ONE picker sits above this page and drives every tab, so an
  // unqualified header has exactly one possible reading — and the only way a
  // bare name could mean two things is if a column on this same table answered
  // to something else. Exactly two do, and both SAY SO in the header: the
  // lifetime pair below, fed by the lifetime aggregate rather than the ranged
  // one. That correspondence — ranged ⇒ no basis, out-of-filter ⇒ basis in the
  // header — is the rule, not the exception, and bar V21 in
  // scripts/test-event-columns-view.ts pins it both ways across this file,
  // HOURLY_COLS and Overview. Adding a column here that the date picker does
  // NOT drive without naming its basis breaks the reading of every bare header
  // beside it, so it goes red.
  //
  // ⭐ "HUMAN CLICKS", NOT "CLICKS" (owner, 2026-09-20) — and the word belongs
  // on THIS pair and on nothing else. `counted_clickers` is deduplicated
  // human-scored PEOPLE and the single EPC denominator; the Operator API has
  // shipped it as `clicks_human` since long before the header said so, and the
  // header now matches that vocabulary instead of contradicting it.
  //
  // ⚠️ DO NOT MOVE THE WORD ONTO `clickers` (four columns to the left). That
  // one is `visit_clicks_clean` — Keitaro's clean landing-page VISITS,
  // BOT-filtered by Keitaro rather than human-scored by CamMan, and explicitly
  // display-only. It is the trap this rename was made to defuse, and bar V23 in
  // scripts/test-event-columns-view.ts goes red if "human" ever lands on it.
  // That column now heads `Landing visits` (owner, 2026-09-20), so "human"
  // would be doubly wrong there: it counts visits, and the header now says so.
  { id: "lifetime_clickers", header: "Human clicks (all time)", kind: "count" },
  { id: "lifetime_epc", header: "EPC (all time)", kind: "usd" },
  { id: "counted_clickers", header: "Human clicks", kind: "count", muted: true },
  { id: "epc", header: "EPC", kind: "usd", muted: true },
  { id: "profit", header: "Profit", kind: "profit" },
];
// Hourly: Sent (by send hour) + activity-time engagement with % rates. Rates use
// the same formulas as the other tabs (÷ sent, redirect ÷ clickers, sales ÷
// redirects). No cost/EPC/profit (cost is a per-stage lump, not hour-bucketable).
// `clickers` heads `Landing visits` here too — one name across the tables that
// show the EPC denominator beside it. ⭐ Overview heads the same metric
// `Clickers` since 2026-09-23 (owner): it dropped both `Human clicks` columns,
// so the confusion the long name guards against cannot arise there. The FULL_COLS
// note above has the reasoning; V24 pins both halves and forbids either string
// from appearing on the other tab.
const HOURLY_COLS: Col[] = [
  { id: "sent", header: "Sent", kind: "count" },
  { id: "opt_outs", header: "Opt-outs", kind: "count", muted: true },
  { id: "opt_out_rate", header: "OptOut %", kind: "pct", muted: true },
  { id: "clickers", header: "Landing visits", kind: "count" },
  { id: "click_rate", header: "CR %", kind: "pct", muted: true },
  { id: "redirects", header: "Redirects", kind: "count" },
  { id: "redirect_rate", header: "Redir %", kind: "pct", muted: true },
  { id: "sales", header: "Sales", kind: "count", title: SALES_NOTE },
  { id: "sales_cr", header: "Sales CR", kind: "pct", muted: true },
  { id: "revenue", header: "Revenue", kind: "usd" },
];

function fmtCell(v: number, kind: Exclude<Col["kind"], "event">): string {
  if (kind === "count") return fmtNum(v);
  if (kind === "pct") return fmtPct(v);
  return fmtUsd(v);
}

/**
 * One cell's value. A GENERATED column is computed from the row's event map and
 * the row's own EPC denominator; every other column is a field on the row. Both
 * the sort comparator and the body cell go through here, so they cannot disagree
 * about what a column is worth.
 */
const cellValue = (r: DerivedRow, c: Col): number | null =>
  c.event
    ? eventCellValue(c.event, r.events ?? {}, r.counted_clickers)
    : (r[c.id as keyof DerivedRow] as number);

export function PerformanceReport({ dimension }: { dimension: ReportDimension }) {
  const isHourly = dimension === "hourly";

  const [filters, updateFilters, resetFilters] = usePersistedFilters<PerfFilters>(
    "reports.performance",
    {
      from: etDate(0),
      to: etDate(0),
      providerPhoneId: null,
      sortBy: DEFAULT_SORT_BY,
      sortDir: "desc",
      showEvents: false,
      showAllColumns: false,
    },
  );

  const api = useApiCall<PerfResponse>();
  const [resp, setResp] = useState<PerfResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      dimension,
      from: filters.from,
      to: filters.to,
    });
    if (filters.providerPhoneId != null) {
      params.set("provider_phone_id", String(filters.providerPhoneId));
    }
    (async () => {
      const result = await api.execute(`/api/reports/performance?${params.toString()}`);
      if (cancelled) return;
      if (result.ok) {
        setResp(result.data);
        setFetchError(null);
      } else {
        // ⭐ THE STALE RESPONSE GOES WITH IT. The error block replaces the TABLE,
        // but the stat cards and the unmapped badge live above it — so a failed
        // fetch used to leave an amber "12 unmapped" beside "Couldn't load
        // report", describing a range the screen is no longer showing. An error
        // state that still carries numbers invites them to be read.
        setResp(null);
        setFetchError(result.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dimension, isHourly, filters.from, filters.to, filters.providerPhoneId, api.execute]);

  // The generated columns AND the bar's numbers, from ONE call over ONE
  // response: the unmapped count the bar renders is read off the same `totals`
  // these columns were built from, and the toggle's governed count is a constant
  // of the registry rather than of the toggle's state (bar W12).
  const block = useMemo<EventColumnBlock>(
    () =>
      eventColumnBlock(
        resp?.event_types ?? [],
        resp?.data ?? [],
        resp?.totals ?? null,
        filters.showEvents,
        filters.showAllColumns,
      ),
    [resp, filters.showEvents, filters.showAllColumns],
  );
  const eventCols: EventColumn[] = block.columns;
  const cols = useMemo<Col[]>(() => {
    const all = isHourly ? HOURLY_COLS : FULL_COLS;
    // The curated default view. A FIXED column is held back by id (the roster is
    // in lib/reporting/column-visibility.ts, where the owner's list is written
    // down once); a GENERATED one was already filtered by kind inside the block
    // above, because a roster of ids cannot survive a new event type.
    const base = filters.showAllColumns
      ? all
      : all.filter((c) => !REPORTS_EXTRA_COLUMN_IDS.has(c.id));
    // Spliced by the ID of the column the block sits BEFORE, not by an index —
    // an index would silently move the block the next time a column is added.
    // Before Sales, so the row reads as one funnel and no existing column moves
    // relative to its neighbours. Sales is never hidden, so the anchor holds in
    // both views.
    const at = base.findIndex((c) => c.id === "sales");
    const generated: Col[] = eventCols.map((e) => ({
      id: e.id,
      header: e.header,
      kind: "event",
      muted: e.muted,
      event: e,
    }));
    return at < 0 ? [...base, ...generated] : [...base.slice(0, at), ...generated, ...base.slice(at)];
  }, [isHourly, eventCols, filters.showAllColumns]);

  // What ticking "Show all columns" would ADD — a constant of the table and its
  // registry, not of the toggle's own state, for the same reason
  // EventBreakdownToggle's count is (a state-dependent count reads 0 while the
  // control is on, and a control announcing 0 unmounts itself). It renders
  // nothing at 0: a checkbox that reveals nothing is a dead control.
  const hiddenColumnCount = useMemo(() => {
    const all = isHourly ? HOURLY_COLS : FULL_COLS;
    // LITERAL true / LITERAL false, never `filters.showAllColumns` — the
    // difference between the two column sets is the thing being counted, and
    // reading the toggle here would make it 0 the moment the toggle is on.
    const generated = (showAll: boolean) =>
      eventColumnBlock(
        resp?.event_types ?? [],
        resp?.data ?? [],
        resp?.totals ?? null,
        filters.showEvents,
        showAll,
      ).columns.length;
    return (
      all.filter((c) => REPORTS_EXTRA_COLUMN_IDS.has(c.id)).length + (generated(true) - generated(false))
    );
  }, [isHourly, resp, filters.showEvents]);

  // ⭐ A PERSISTED SORT CAN NAME A COLUMN THAT NO LONGER EXISTS. A generated id
  // belongs to a registry row, and `sortBy` outlives it in localStorage. Sorting
  // by an id that matches no column used to tie every comparison — the rows came
  // out in API order with no arrow anywhere, which reads exactly like a sorted
  // table. It falls back to the default column instead, VISIBLY: the rows are
  // sorted by it and the indicator says so.
  const sortBy = sortColumnOrFallback(
    cols.map((c) => c.id),
    filters.sortBy,
    DEFAULT_SORT_BY,
  );

  const rows = useMemo<DerivedRow[]>(() => {
    const derived = (resp?.data ?? []).map(derive);
    const key = sortBy as keyof DerivedRow;
    const sortCol = cols.find((c) => c.id === sortBy);
    // Pinned row first → clicked column (direction-flipped) → Landing visits
    // high-to-low (never flipped) → the row's `key` (never flipped). The key
    // order and the comparator are shared with Overview's server-side sort in
    // lib/reporting/report-sort.ts, so the tabs cannot drift.
    return [...derived].sort(
      makeDimensionComparator<DerivedRow>(
        filters.sortDir,
        sortBy === "clickers",
        (r) =>
          sortCol
            ? cellValue(r, sortCol)
            : (r[key] as unknown as number | string | null),
      ),
    );
  }, [resp, sortBy, filters.sortDir, cols]);

  const totals = resp?.totals ?? null;
  const providers = resp?.providers ?? [];

  function toggleSort(id: string) {
    if (filters.sortBy === id) updateFilters({ sortDir: filters.sortDir === "asc" ? "desc" : "asc" });
    else updateFilters({ sortBy: id, sortDir: "desc" });
  }
  // Reads the EFFECTIVE sort, so the arrow sits on the column the rows are
  // actually ordered by — including when a persisted id named a column that is
  // no longer generated.
  const sortIndicator = (id: string) =>
    sortBy === id ? (filters.sortDir === "asc" ? " ▲" : " ▼") : "";

  function renderLabel(r: DerivedRow) {
    if (r.pinned) return <span className="text-sm font-medium">{r.label}</span>;
    if (dimension === "number") {
      return (
        <ProviderPhoneCell
          providers={r.provider_name ? [{ name: r.provider_name, color: r.provider_color }] : []}
          phones={r.phone_number ? [{ phone_number: r.phone_number, number_type: r.number_type ?? undefined }] : []}
        />
      );
    }
    if (dimension === "group") {
      return (
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ backgroundColor: r.group_color ?? "#64748B" }} />
          <span className="text-sm">{r.label}</span>
        </span>
      );
    }
    return <span className="text-sm">{r.label}</span>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="perf-from">From</Label>
          <Input
            id="perf-from"
            type="date"
            value={filters.from}
            max={filters.to}
            onChange={(e) => updateFilters({ from: e.target.value })}
            className="h-9 w-[160px]"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="perf-to">To</Label>
          <Input
            id="perf-to"
            type="date"
            value={filters.to}
            min={filters.from}
            onChange={(e) => updateFilters({ to: e.target.value })}
            className="h-9 w-[160px]"
          />
        </div>
        <div className="grid gap-1.5">
          <Label>Provider / number</Label>
          <Select
            value={filters.providerPhoneId == null ? "all" : String(filters.providerPhoneId)}
            onValueChange={(v) => updateFilters({ providerPhoneId: v === "all" ? null : Number(v) })}
          >
            <SelectTrigger className="h-9 w-[220px]">
              <SelectValue placeholder="All numbers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All numbers</SelectItem>
              {providers.map((p) => (
                <SelectItem key={p.provider_phone_id} value={String(p.provider_phone_id)}>
                  {(p.provider_name ?? "?") + " · " + (p.phone_number ?? "—")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="ghost" size="sm" onClick={resetFilters}>
          Reset
        </Button>
        {resp?.refreshedAt ? (
          <span className="ml-auto self-center text-xs text-muted-foreground">
            Data as of {formatCampaignDateTime(resp.refreshedAt)}
          </span>
        ) : null}
      </div>

      {dimension === "group" ? (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground"
          title={GROUP_CLICKS_NOTE}
        >
          <span className="font-medium text-foreground">Click counts on this tab are split shares, not people.</span>{" "}
          A contact in several of a campaign&apos;s groups contributes a fraction to each, so these
          counts cannot be deduplicated and are <span className="font-medium">not comparable</span> with
          By Number, By Offer or By Sequence — those count distinct people.
        </div>
      ) : null}

      {totals ? (
        isHourly ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Sent" value={fmtInt(totals.sent)} />
            <StatCard label="Opt-out %" value={fmtPct(rate(totals.opt_outs, totals.sent))} />
            <StatCard label="Landing visits" value={fmtInt(totals.clickers)} />
            <StatCard label="Redirects" value={fmtInt(totals.redirects)} />
            <StatCard
              label="Sales"
              value={fmtInt(totals.sales)}
              hint={totals.manual_topup > 0 ? `${fmtInt(totals.manual_topup)} from the manual tally` : undefined}
            />
            <StatCard label="Revenue" value={fmtUsd(totals.revenue)} />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            <StatCard label="Sent" value={fmtInt(totals.sent)} />
            <StatCard label="Opt-out %" value={fmtPct(rate(totals.opt_outs, totals.sent))} />
            <StatCard label="Landing visits" value={fmtInt(totals.clickers)} />
            <StatCard label="Redirects" value={fmtInt(totals.redirects)} />
            <StatCard
              label="Sales"
              value={fmtInt(totals.sales)}
              hint={totals.manual_topup > 0 ? `${fmtInt(totals.manual_topup)} from the manual tally` : undefined}
            />
            <StatCard label="Revenue" value={fmtUsd(totals.revenue)} />
            <StatCard label="Cost" value={fmtUsd(totals.cost)} />
            <StatCard label="Profit" value={fmtUsd(totals.revenue - totals.cost)} />
          </div>
        )
      ) : null}

      <p className="text-xs text-muted-foreground">
        {isHourly ? (
          <>
            Each hour is summed across the selected date range in {CAMPAIGN_TIMEZONE_LABEL}. <span className="font-medium">Sent</span> is
            by send hour; engagement is by <span className="font-medium">user-activity time</span> — clicks by click
            time, sales by conversion time, opt-outs by receipt time (internal event data; clicks won&apos;t equal the
            Keitaro count on Overview). Rates are each action ÷ sent (redirect ÷ landing visits, sales ÷ redirects).
            Manual-campaign results have no per-event time and roll up into the pinned{" "}
            <span className="font-medium">Manual</span> row.
          </>
        ) : (
          <>
            Sourced from the same Keitaro data as Overview, grouped by{" "}
            <span className="font-medium">{DIMENSION_LABEL[dimension].toLowerCase()}</span> — totals reconcile to the
            Overview tab. EPC = revenue ÷ offer redirects.
            {dimension === "group"
              ? " Each stage's totals are split across its contact groups (tracked: per contact across the groups used in the campaign; manual: by each group's audience share), so group rows sum back to the stage total. Values may show 2 decimals."
              : ""}{" "}
            Event columns are generated from your event-type registry: a count, a rate and a held count
            per type, plus the signal→purchase conversion rate, and — under{" "}
            <span className="font-medium">Event breakdown</span> — each revenue-bearing type&apos;s
            revenue, held $ and EPC. Rates divide by <span className="font-medium">Human clicks</span>,
            the same denominator as EPC, and can exceed 100% when a conversion&apos;s click was never
            scored human. A dash means the denominator was zero. The table opens on a shorter default
            view — each event type&apos;s count and the funnel ratio, with its rate and held count under{" "}
            <span className="font-medium">Show all columns</span> alongside the other second-order
            figures.
          </>
        )}
      </p>

      {/* ⭐ MOUNTED UNCONDITIONALLY, AND NEVER INSIDE A `showEvents` BRANCH.
          EventColumnsBar carries the Event-breakdown toggle AND the unmapped
          badge together (they are not separately exported), so the breakdown
          cannot be on screen while the count of conversions it fails to explain
          is hidden. It takes the same `block` the columns came from, so the two
          cannot describe different responses. It sits OUTSIDE the empty state: a
          wholly unmapped conversion resolves to no stage, so it appears in no
          row and a range whose table is empty can still have strays worth
          seeing. On a fetch ERROR there is nothing to describe — the response is
          cleared, so the block is empty and the bar renders nothing.

          ⭐ THE COLUMN TOGGLE SITS BESIDE THE BAR, NEVER AROUND IT. It governs
          `cols`, which is downstream of `block.columns`; `block.bar` is built
          from `totals` and is not reachable from here at all. So the curated
          view can drop generated columns and cannot drop the count of
          conversions they fail to explain — the badge is rendered by the same
          unconditional mount it always was. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <EventColumnsBar block={block} onShowEventsChange={(v) => updateFilters({ showEvents: v })} />
        {hiddenColumnCount > 0 ? (
          <label className="inline-flex cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-3.5 accent-current"
              checked={filters.showAllColumns}
              onChange={(e) => updateFilters({ showAllColumns: e.target.checked })}
            />
            Show all columns
            <span className="text-muted-foreground/70">({hiddenColumnCount} more columns)</span>
          </label>
        ) : null}
      </div>

      {fetchError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">Couldn&apos;t load report: {fetchError}</p>
        </div>
      ) : !api.isLoading && rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed py-16 text-center">
          <BarChart3 className="size-12 text-muted-foreground/40" aria-hidden />
          <div className="space-y-1">
            <p className="text-sm font-medium">No activity in this range</p>
            <p className="text-sm text-muted-foreground">
              Try a wider date range.
            </p>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left">
                {/* Frozen — the tint is this header row's own flat `bg-muted/40`,
                    not a hover state, so it is unconditional. */}
                <th
                  className={`${FROZEN_FIRST_COLUMN_CELL} before:bg-muted/40 px-3 py-2 font-medium`}
                >
                  {isHourly ? "Hour" : DIMENSION_LABEL[dimension]}
                </th>
                {cols.map((c) => (
                  <th
                    key={c.id}
                    title={c.title}
                    className="cursor-pointer select-none whitespace-nowrap px-3 py-2 text-right font-medium hover:text-foreground"
                    onClick={() => toggleSort(c.id)}
                  >
                    {c.header}
                    {sortIndicator(c.id)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b last:border-0 hover:bg-muted/30">
                  <td
                    className={`${FROZEN_FIRST_COLUMN_CELL} [tr:hover>&]:before:bg-muted/30 px-3 py-2`}
                  >
                    {renderLabel(r)}
                  </td>
                  {cols.map((c) => {
                    const v = cellValue(r, c);
                    const cls =
                      c.kind === "profit"
                        ? (v ?? 0) >= 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-destructive"
                        : c.muted
                          ? "text-muted-foreground"
                          : "";
                    return (
                      <td key={c.id} className={`whitespace-nowrap px-3 py-2 text-right tabular-nums ${cls}`}>
                        {c.event
                          ? fmtEventCell(v, c.event.kind)
                          : fmtCell(v as number, c.kind as Exclude<Col["kind"], "event">)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
