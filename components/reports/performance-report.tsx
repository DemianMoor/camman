"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart3 } from "lucide-react";

import { ProviderPhoneCell } from "@/components/provider-phone-cell";
import {
  EventColumnsBar,
  eventCellValue,
  eventColsFor,
  fmtEventCell,
  tierBColumnCount,
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
import type { EventColumn, EventTypeSpec } from "@/lib/reporting/event-columns";
import type {
  PerfMetrics,
  PerfRow,
  ProviderOption,
} from "@/lib/reporting/performance-report";
import { DIMENSION_LABEL, type ReportDimension } from "@/lib/reporting/report-dimensions";

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
  { id: "clickers", header: "Clickers", kind: "count" },
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
  // interpretable when you can see the denominator was 4. Headers name the time
  // basis explicitly so nobody has to guess which column is which.
  { id: "lifetime_clickers", header: "Clicks (all time)", kind: "count" },
  { id: "lifetime_epc", header: "EPC (all time)", kind: "usd" },
  { id: "counted_clickers", header: "Clicks (period)", kind: "count", muted: true },
  { id: "epc", header: "EPC (period)", kind: "usd", muted: true },
  { id: "profit", header: "Profit", kind: "profit" },
];
// Hourly: Sent (by send hour) + activity-time engagement with % rates. Rates use
// the same formulas as the other tabs (÷ sent, redirect ÷ clickers, sales ÷
// redirects). No cost/EPC/profit (cost is a per-stage lump, not hour-bucketable).
const HOURLY_COLS: Col[] = [
  { id: "sent", header: "Sent", kind: "count" },
  { id: "opt_outs", header: "Opt-outs", kind: "count", muted: true },
  { id: "opt_out_rate", header: "OptOut %", kind: "pct", muted: true },
  { id: "clickers", header: "Clickers", kind: "count" },
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
      sortBy: "sent",
      sortDir: "desc",
      showEvents: false,
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
        setFetchError(result.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dimension, isHourly, filters.from, filters.to, filters.providerPhoneId, api.execute]);

  const eventCols = useMemo<EventColumn[]>(
    () => eventColsFor(resp?.event_types ?? [], resp?.data ?? [], resp?.totals ?? null, filters.showEvents),
    [resp, filters.showEvents],
  );
  // How many columns the toggle GOVERNS — a constant of the registry, not of the
  // toggle's state. tierBColumnCount() cannot see the toggle at all, so the
  // "count reads 0 while it is on, the control unmounts and tier B can never be
  // switched off" bug is unrepresentable here. Bar W12.
  const tierBCount = useMemo(
    () => tierBColumnCount(resp?.event_types ?? [], resp?.data ?? [], resp?.totals ?? null),
    [resp],
  );
  const cols = useMemo<Col[]>(() => {
    const base = isHourly ? HOURLY_COLS : FULL_COLS;
    // Spliced by the ID of the column the block sits BEFORE, not by an index —
    // an index would silently move the block the next time a column is added.
    // Before Sales, so the row reads as one funnel and no existing column moves
    // relative to its neighbours.
    const at = base.findIndex((c) => c.id === "sales");
    const generated: Col[] = eventCols.map((e) => ({
      id: e.id,
      header: e.header,
      kind: "event",
      muted: e.muted,
      event: e,
    }));
    return at < 0 ? [...base, ...generated] : [...base.slice(0, at), ...generated, ...base.slice(at)];
  }, [isHourly, eventCols]);

  const rows = useMemo<DerivedRow[]>(() => {
    const derived = (resp?.data ?? []).map(derive);
    const dir = filters.sortDir === "asc" ? 1 : -1;
    const key = filters.sortBy as keyof DerivedRow;
    const sortCol = cols.find((c) => c.id === filters.sortBy);
    return [...derived].sort((a, b) => {
      // Pinned rows (hourly "Manual") always sort to the top.
      if (a.pinned && !b.pinned) return -1;
      if (b.pinned && !a.pinned) return 1;
      const av = sortCol ? cellValue(a, sortCol) : a[key];
      const bv = sortCol ? cellValue(b, sortCol) : b[key];
      // "Unknown" sorts LAST in BOTH directions — it is not a small number. Same
      // rule as the Overview API's comparator.
      if (av == null && bv != null) return 1;
      if (bv == null && av != null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
    });
  }, [resp, filters.sortBy, filters.sortDir, cols]);

  const totals = resp?.totals ?? null;
  const providers = resp?.providers ?? [];

  function toggleSort(id: string) {
    if (filters.sortBy === id) updateFilters({ sortDir: filters.sortDir === "asc" ? "desc" : "asc" });
    else updateFilters({ sortBy: id, sortDir: "desc" });
  }
  const sortIndicator = (id: string) =>
    filters.sortBy === id ? (filters.sortDir === "asc" ? " ▲" : " ▼") : "";

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
            <StatCard label="Clickers" value={fmtInt(totals.clickers)} />
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
            <StatCard label="Clickers" value={fmtInt(totals.clickers)} />
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
            Keitaro count on Overview). Rates are each action ÷ sent (redirect ÷ clickers, sales ÷ redirects).
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
            revenue, held $ and EPC. Rates divide by <span className="font-medium">Clicks (period)</span>,
            the same denominator as EPC, and can exceed 100% when a conversion&apos;s click was never
            scored human. A dash means the denominator was zero.
          </>
        )}
      </p>

      {/* ⭐ MOUNTED UNCONDITIONALLY, AND NEVER INSIDE A `showEvents` BRANCH.
          EventColumnsBar carries the Event-breakdown toggle AND the unmapped
          badge together (they are not separately exported), so the breakdown
          cannot be on screen while the count of conversions it fails to explain
          is hidden. It sits OUTSIDE the empty/error states too: a wholly
          unmapped conversion resolves to no stage, so it appears in no row and
          a range whose table is empty can still have strays worth seeing. */}
      <EventColumnsBar
        showEvents={filters.showEvents}
        onShowEventsChange={(v) => updateFilters({ showEvents: v })}
        tierBCount={tierBCount}
        unmapped={totals?.unmapped ?? 0}
      />

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
                <th className="px-3 py-2 font-medium">{isHourly ? "Hour" : DIMENSION_LABEL[dimension]}</th>
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
                  <td className="px-3 py-2">{renderLabel(r)}</td>
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
