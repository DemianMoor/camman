"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BarChart3, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/data-table";
import { useAuth } from "@/components/protected/auth-context";
import {
  EventColumnsBar,
  eventCellValue,
  eventColumnBlock,
  fmtEventCell,
  type EventColumnBlock,
} from "@/components/reports/event-columns-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CAMPAIGN_TIMEZONE_LABEL } from "@/lib/campaign-timezone";
import {
  formatPhoneInternational,
  formatPhoneLast4,
} from "@/lib/phone-validation";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import type { EventMap, EventTypeSpec } from "@/lib/reporting/event-columns";

// The "Overview" tab of /reports — the Keitaro Clickers → Offer Redirect → Sales
// funnel, per stage or per campaign. Moved verbatim out of app/(protected)/reports
// /page.tsx (which is now a thin tab router) when the five performance reports were
// added; the page's <h1> + tab bar now live in the router, so this renders its own
// controls/table only.
type ReportRow = {
  stage_id: number | null;
  campaign_id: number;
  campaign_name: string;
  stage_number: number | null;
  stage_name: string | null;
  stage_tracking_id: string | null;
  stage_count: number | null;
  // Send number(s) behind the row — one for a stage row, the distinct set
  // across the campaign's stages for a campaign row. Empty when the stage has
  // no provider phone assigned.
  phones: { phone_number: string; number_type: string | null }[];
  opt_outs: number;
  total_sent: number;
  opt_out_rate: number;
  clickers: number;
  click_rate: number;
  // True when `clickers` is CamMan's count standing in for a missing Keitaro
  // visit count. Marks the value and blanks click_rate/redirect_rate — not
  // because both divide by the missing denominator (only redirect_rate does;
  // click_rate's denominator is total_sent and the substitute is its
  // numerator), but because both would mix a Keitaro basis with a CamMan one.
  clickers_is_fallback: boolean;
  offer_redirect: number;
  redirect_rate: number;
  sales: number;
  sales_cr: number;
  revenue: number;
  pending_revenue: number;
  cost: number;
  epc: number; // PERIOD — the selected date range
  counted_clickers: number;
  lifetime_epc: number; // LIFETIME — ignores the date filter; the PRIMARY figure
  lifetime_clickers: number;
  profit: number;
  // Delivery receipts (lib/reporting/delivery.ts — the same layer behind
  // /reports/delivery and the undelivered tripwire). null when the grain has no
  // DLR-capable sends, or when the selected range exceeds the delivery cap.
  delivered_pct: number | null;
  // < 100 ⇒ a MIXED-capability campaign; the figure must be labelled with its
  // coverage or a 4%-coverage number is indistinguishable from a 100% one.
  delivery_coverage_pct: number | null;
  // The per-event-type breakdown of sales / revenue, keyed by event_types.key.
  // The columns over it are GENERATED from the registry the response carries.
  events: EventMap;
  // Conversions in scope that matched no mapping. Counted in NO other field —
  // which is why only the amber badge can tell you they exist.
  unmapped: number;
  // The part of `sales` that came from the manual tally rather than the tracker:
  //   sales = Σ (is_purchase) events[t].n + manual_topup + unmapped strays
  manual_topup: number;
};

// Delivered % cell. Three distinct "no number" cases, which must not look alike:
//   · range too wide  — the delivery query is capped at 14 days (measured: 473 ms
//                       at 7 days vs 11.0 s at 30), so the column is not computed
//   · no capable sends — this grain sends only via providers with no DLR intake
//   · partial coverage — a MIXED campaign: show the figure AND label its coverage,
//                        because 91.4% over 4% of sends is not the same claim as
//                        91.4% over all of them
function DeliveredCell({ row, available }: { row: ReportRow; available: boolean }) {
  if (!available) {
    return (
      <span className="text-muted-foreground/60" title="Delivery % is only computed for ranges of 14 days or less. Narrow the date range to see it.">
        —
      </span>
    );
  }
  if (row.delivered_pct === null) {
    return (
      <span className="text-muted-foreground/60" title="No delivery-receipt data: these sends went via a provider with no DLR intake.">
        —
      </span>
    );
  }
  const coverage = row.delivery_coverage_pct;
  const partial = coverage !== null && coverage < 100;
  return (
    <span className="tabular-nums">
      {row.delivered_pct.toFixed(1)}%
      {partial ? (
        <span
          className="ml-1 text-[11px] text-muted-foreground"
          title="This campaign sends via more than one provider and only some of them report delivery receipts. The percentage covers only that measurable share of its sends."
        >
          (of {coverage.toFixed(0)}% of sends)
        </span>
      ) : null}
    </span>
  );
}

type Totals = Omit<
  ReportRow,
  | "stage_id"
  | "campaign_id"
  | "campaign_name"
  | "stage_number"
  | "stage_name"
  | "stage_tracking_id"
  | "stage_count"
  // Deliberately NOT in the totals card. An org-wide "Delivered %" would need a
  // denominator choice (all sends? DLR-capable sends?) that no single number can
  // carry honestly while ~99.9% of volume has no receipts. /reports/delivery
  // shows the per-provider breakdown instead, where the denominator is explicit.
  | "delivered_pct"
  | "delivery_coverage_pct"
>;

type GroupBy = "stage" | "campaign";

type ReportResponse = {
  data: ReportRow[];
  totalCount: number;
  totals: Totals;
  // The event-type registry. The per-event columns are GENERATED from it, so an
  // empty array simply means no event columns — never a broken table.
  event_types: EventTypeSpec[];
  // available=false ⇒ the selected range exceeds the delivery cap and the
  // Delivered % column was not computed at all (see DeliveredCell).
  delivery?: { available: boolean; max_days: number };
  range: { from: string; to: string; timezone: string };
};

type PollResponse = {
  ok: boolean;
  degraded: boolean;
  matched: number;
  upserted: number;
  unmatched: number;
  classification_degraded: boolean;
  error: string | null;
};

type Filters = {
  from: string;
  to: string;
  search: string;
  groupBy: GroupBy;
  page: number;
  pageSize: number;
  sortBy: string;
  sortDir: "asc" | "desc";
  // Per-browser, off by default. It governs ONLY the per-event money columns
  // (tier B), each of which duplicates an aggregate column already on screen.
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

const DEFAULT_FILTERS: Filters = {
  from: etDate(-6),
  to: etDate(0),
  search: "",
  groupBy: "stage",
  page: 0,
  pageSize: 20,
  sortBy: "revenue",
  sortDir: "desc",
  showEvents: false,
};

const SEARCH_DEBOUNCE_MS = 300;

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
function fmtUsd(n: number): string {
  return usd.format(n);
}
function fmtInt(n: number): string {
  return n.toLocaleString();
}
function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// Why Sales does not equal the sum of the purchase columns beside it. Said on
// the column AND on the stat card, because whichever one is read first is the
// one that has to explain itself.
const SALES_NOTE =
  "Tracker conversions plus the manual tally. The per-event columns count tracker events only, so they sum to Sales minus the manual top-up (and minus any unmapped conversions, which the amber badge counts).";

// The Campaign cell carries two lines (name + send number), so an unbounded
// name would push the metric columns off screen. Anything past 50 characters
// is cut here and the full name is reachable by hovering the link.
const MAX_CAMPAIGN_NAME_CHARS = 50;
function truncateCampaignName(name: string): string {
  return name.length > MAX_CAMPAIGN_NAME_CHARS
    ? name.slice(0, MAX_CAMPAIGN_NAME_CHARS - 1).trimEnd() + "…"
    : name;
}

// The number(s) a row was sent from, under the campaign name. Short codes are
// only recognisable in full; every other type collapses to its last 4 digits.
// A campaign row can span stages on different numbers — the first few are
// listed and the rest counted, with all of them in full on hover.
const MAX_PHONES_SHOWN = 3;
function fullPhoneLabel(p: ReportRow["phones"][number]): string {
  return p.number_type === "short_code"
    ? p.phone_number
    : formatPhoneInternational(p.phone_number);
}
function SendNumbers({ phones }: { phones: ReportRow["phones"] }) {
  if (phones.length === 0) return null;
  const shown = phones.slice(0, MAX_PHONES_SHOWN);
  const hidden = phones.length - shown.length;
  return (
    <span
      className="font-mono text-[11px] text-muted-foreground"
      title={phones.map(fullPhoneLabel).join(", ")}
    >
      {shown
        .map((p) => formatPhoneLast4(p.phone_number, p.number_type))
        .join(", ")}
      {hidden > 0 ? ` +${hidden}` : ""}
    </span>
  );
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

export function KeitaroReport() {
  const { auth, can } = useAuth();
  const canRefresh = can("result_imports.create");

  const [filters, updateFilters, resetFilters] = usePersistedFilters<Filters>(
    "reports.filters",
    DEFAULT_FILTERS,
  );

  const [searchInput, setSearchInput] = useState(filters.search);
  useEffect(() => {
    setSearchInput(filters.search);
  }, [filters.search]);
  useEffect(() => {
    if (searchInput === filters.search) return;
    const t = setTimeout(() => {
      updateFilters({ search: searchInput, page: 0 });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput, filters.search, updateFilters]);

  const listApi = useApiCall<ReportResponse>();
  const pollApi = useApiCall<PollResponse>();

  const [data, setData] = useState<ReportRow[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [eventTypes, setEventTypes] = useState<EventTypeSpec[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Whether the server computed the Delivered % column at all for this range.
  const [deliveryAvailable, setDeliveryAvailable] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  const refetch = useCallback(() => setRefreshTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setFetchError(null);
    const params = new URLSearchParams({
      from: filters.from,
      to: filters.to,
      groupBy: filters.groupBy,
      page: String(filters.page),
      pageSize: String(filters.pageSize),
      sortBy: filters.sortBy,
      sortDir: filters.sortDir,
    });
    if (filters.search) params.set("search", filters.search);

    (async () => {
      const result = await listApi.execute(
        `/api/keitaro/reports?${params.toString()}`,
      );
      if (cancelled) return;
      if (result.ok) {
        setData(result.data.data);
        setTotals(result.data.totals);
        setEventTypes(result.data.event_types ?? []);
        setTotalCount(result.data.totalCount);
        setDeliveryAvailable(result.data.delivery?.available ?? true);
      } else {
        // ⭐ THE STALE RESPONSE GOES WITH IT. The error block replaces the
        // TABLE, but the stat cards and the unmapped badge sit above it — so a
        // failed fetch used to leave an amber "12 unmapped" and a full set of
        // totals beside "Couldn't load reports", describing a range the screen
        // is no longer showing. Cleared, the cards and the badge render nothing
        // and the error is the only claim on the page. Retry refills them.
        setData([]);
        setTotals(null);
        setEventTypes([]);
        setTotalCount(0);
        setFetchError(result.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    filters.from,
    filters.to,
    filters.search,
    filters.groupBy,
    filters.page,
    filters.pageSize,
    filters.sortBy,
    filters.sortDir,
    refreshTick,
    listApi.execute,
  ]);

  async function handleRefresh() {
    const result = await pollApi.execute("/api/keitaro/poll", {
      method: "POST",
    });
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    const p = result.data;
    if (p.degraded) {
      toast.error(`Keitaro sync failed: ${p.error ?? "unknown error"}`);
    } else {
      toast.success(
        `Synced ${p.upserted} stage-day${p.upserted === 1 ? "" : "s"}` +
          (p.classification_degraded
            ? " — visit/redirect classification degraded (campaigns list unavailable)"
            : ""),
      );
    }
    refetch();
  }

  // The generated columns AND the bar's numbers, from ONE call over ONE
  // response: the unmapped count the bar renders is read off the same `totals`
  // these columns were built from, and the toggle's governed count is a constant
  // of the registry rather than of the toggle's state (bar W12).
  const block = useMemo<EventColumnBlock>(
    () => eventColumnBlock(eventTypes, data, totals, filters.showEvents),
    [eventTypes, data, totals, filters.showEvents],
  );

  const columns = useMemo<ColumnDef<ReportRow>[]>(() => {
    const campaignCol: ColumnDef<ReportRow> = {
      id: "campaign_name",
      header: "Campaign",
      enableSorting: true,
      cell: ({ row }) => {
        const name = row.original.campaign_name;
        const shortName = truncateCampaignName(name);
        return (
          <div className="flex max-w-[22rem] flex-col gap-0.5">
            <Link
              href={`/campaigns/${row.original.campaign_id}`}
              className="font-medium text-primary hover:underline"
              title={shortName === name ? undefined : name}
            >
              {shortName}
            </Link>
            <SendNumbers phones={row.original.phones} />
          </div>
        );
      },
    };
    const stageCol: ColumnDef<ReportRow> =
      filters.groupBy === "campaign"
        ? {
            id: "stages",
            header: "Stages",
            enableSorting: false,
            cell: ({ row }) => (
              <span className="tabular-nums text-muted-foreground">
                {fmtInt(row.original.stage_count ?? 0)}
              </span>
            ),
          }
        : {
            id: "stage",
            header: "Stage",
            enableSorting: false,
            cell: ({ row }) => (
              <Link
                href={`/campaigns/${row.original.campaign_id}?stage=${row.original.stage_id}`}
                className="flex flex-col gap-0.5 hover:underline"
              >
                <span className="text-primary">{row.original.stage_name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {row.original.stage_tracking_id}
                </span>
              </Link>
            ),
          };
    const rest: ColumnDef<ReportRow>[] = [
      {
        id: "total_sent",
        header: "Total Sent",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums">{fmtInt(row.original.total_sent)}</span>
        ),
      },
      {
        id: "opt_outs",
        header: "Opt-outs",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {fmtInt(row.original.opt_outs)}
          </span>
        ),
      },
      {
        id: "opt_out_rate",
        header: "OptOut, %",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {fmtPct(row.original.opt_out_rate)}
          </span>
        ),
      },
      {
        id: "delivered_pct",
        header: "Delivered, %",
        enableSorting: false,
        cell: ({ row }) => <DeliveredCell row={row.original} available={deliveryAvailable} />,
      },
      {
        id: "clickers",
        header: "Clickers",
        enableSorting: true,
        cell: ({ row }) => (
          <span
            className="tabular-nums"
            title={
              row.original.clickers_is_fallback
                ? "CamMan clicks — Keitaro visits unavailable"
                : undefined
            }
          >
            {fmtInt(row.original.clickers)}
            {row.original.clickers_is_fallback ? (
              <sup className="text-muted-foreground">*</sup>
            ) : null}
          </span>
        ),
      },
      {
        id: "click_rate",
        header: "CR, %",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {row.original.clickers_is_fallback ? "—" : fmtPct(row.original.click_rate)}
          </span>
        ),
      },
      {
        id: "offer_redirect",
        header: "Offer Redirect",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {fmtInt(row.original.offer_redirect)}
          </span>
        ),
      },
      {
        id: "redirect_rate",
        header: "Redirect %",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {row.original.clickers_is_fallback ? "—" : fmtPct(row.original.redirect_rate)}
          </span>
        ),
      },
      {
        id: "sales",
        header: () => <span title={SALES_NOTE}>Sales</span>,
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums">{fmtInt(row.original.sales)}</span>
        ),
      },
      {
        id: "sales_cr",
        header: "Sales CR",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {fmtPct(row.original.sales_cr)}
          </span>
        ),
      },
      {
        id: "revenue",
        header: "Revenue",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums">{fmtUsd(row.original.revenue)}</span>
        ),
      },
      {
        id: "pending_revenue",
        header: "Pending $",
        enableSorting: true,
        // "—" when nothing is held, like the totals tile and the campaign page's
        // stage cell: held money is shown where it exists, and a column of
        // "$0.00" reads as a measured zero rather than "no held conversions".
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {row.original.pending_revenue > 0 ? fmtUsd(row.original.pending_revenue) : "—"}
          </span>
        ),
      },
      {
        id: "cost",
        header: "Cost",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {fmtUsd(row.original.cost)}
          </span>
        ),
      },
      // LIFETIME first — the primary figure, ignoring the date filter entirely.
      // Each EPC sits immediately after the count it divided by, because a $0.00
      // EPC is only interpretable when you can see the denominator was 4. The
      // two are NOT derivable from one another: counted clickers are
      // deduplicated, so a lifetime figure can never be summed out of periods.
      {
        id: "lifetime_clickers",
        header: "Clicks (all time)",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.lifetime_clickers.toLocaleString()}
          </span>
        ),
      },
      {
        id: "lifetime_epc",
        header: "EPC (all time)",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums font-medium">
            {fmtUsd(row.original.lifetime_epc)}
          </span>
        ),
      },
      {
        id: "counted_clickers",
        header: "Clicks (period)",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {row.original.counted_clickers.toLocaleString()}
          </span>
        ),
      },
      {
        id: "epc",
        header: "EPC (period)",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {fmtUsd(row.original.epc)}
          </span>
        ),
      },
      {
        id: "profit",
        header: "Profit",
        enableSorting: true,
        cell: ({ row }) => (
          <span
            className={
              row.original.profit >= 0
                ? "tabular-nums text-emerald-600 dark:text-emerald-400"
                : "tabular-nums text-destructive"
            }
          >
            {fmtUsd(row.original.profit)}
          </span>
        ),
      },
    ];
    // The GENERATED block, spliced by the ID of the column it sits BEFORE rather
    // than by an index — an index would silently move the block the next time a
    // column is added. Before Sales, so the row reads as one funnel and no
    // existing column moves relative to its neighbours.
    const generated: ColumnDef<ReportRow>[] = block.columns.map((e) => ({
      id: e.id,
      header: e.header,
      enableSorting: true,
      cell: ({ row }) => (
        <span className={`tabular-nums${e.muted ? " text-muted-foreground" : ""}`}>
          {fmtEventCell(
            eventCellValue(e, row.original.events ?? {}, row.original.counted_clickers),
            e.kind,
          )}
        </span>
      ),
    }));
    const at = rest.findIndex((c) => c.id === "sales");
    const withEvents =
      at < 0 ? [...rest, ...generated] : [...rest.slice(0, at), ...generated, ...rest.slice(at)];
    return [campaignCol, stageCol, ...withEvents];
  }, [filters.groupBy, deliveryAvailable, block]);

  const isAuthLoading = !auth;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Live campaign performance from Keitaro: the Clickers → Offer Redirect →
          Sales funnel, per stage or rolled up per campaign. Times in{" "}
          {CAMPAIGN_TIMEZONE_LABEL}.
        </p>
        {canRefresh ? (
          <Button
            variant="outline"
            onClick={handleRefresh}
            disabled={pollApi.isLoading}
          >
            <RefreshCw
              className={pollApi.isLoading ? "size-4 animate-spin" : "size-4"}
              aria-hidden
            />
            {pollApi.isLoading ? "Syncing…" : "Refresh from Keitaro"}
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="from">From</Label>
          <Input
            id="from"
            type="date"
            value={filters.from}
            max={filters.to}
            onChange={(e) => updateFilters({ from: e.target.value, page: 0 })}
            className="h-9 w-[160px]"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="to">To</Label>
          <Input
            id="to"
            type="date"
            value={filters.to}
            min={filters.from}
            onChange={(e) => updateFilters({ to: e.target.value, page: 0 })}
            className="h-9 w-[160px]"
          />
        </div>
        <div className="grid gap-1.5">
          <Label>Group by</Label>
          <div className="flex h-9 items-center rounded-md border p-0.5">
            {(["stage", "campaign"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => updateFilters({ groupBy: g, page: 0 })}
                className={
                  "h-8 rounded px-3 text-sm capitalize transition-colors " +
                  (filters.groupBy === g
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                {g}
              </button>
            ))}
          </div>
        </div>
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search campaign, stage, tracking id…"
          className="h-9 w-full max-w-xs"
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            resetFilters();
            setSearchInput("");
          }}
        >
          Reset
        </Button>
      </div>

      {totals ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-8">
            <StatCard
              label="Clickers"
              value={`${fmtInt(totals.clickers)}${totals.clickers_is_fallback ? "*" : ""}`}
            />
            <StatCard
              label="Offer Redirect"
              value={fmtInt(totals.offer_redirect)}
            />
            <StatCard
              label="Sales"
              value={fmtInt(totals.sales)}
              hint={totals.manual_topup > 0 ? `${fmtInt(totals.manual_topup)} from the manual tally` : undefined}
            />
            <StatCard label="Revenue" value={fmtUsd(totals.revenue)} />
            {/* Held money, beside the revenue it is NOT part of. The table has
                carried a "Pending $" column since Task 6; without the tile the
                totals card silently dropped the figure at the one grain an
                operator reads first. "—" when nothing is held, matching the
                campaign page's tile rather than asserting $0.00. */}
            <StatCard
              label="Pending $"
              value={totals.pending_revenue > 0 ? fmtUsd(totals.pending_revenue) : "—"}
            />
            <StatCard label="Cost" value={fmtUsd(totals.cost)} />
            <StatCard label="Profit" value={fmtUsd(totals.profit)} />
            <StatCard label="Avg Opt-out" value={fmtPct(totals.opt_out_rate)} />
          </div>
          {totals.clickers_is_fallback ? (
            <p className="mt-2 text-xs text-muted-foreground">
              * CamMan clicks — Keitaro visits unavailable for this period. Rates that
              divide by Keitaro visits show —.
            </p>
          ) : null}
        </>
      ) : null}

      {/* ⭐ MOUNTED UNCONDITIONALLY, AND NEVER INSIDE A `showEvents` BRANCH.
          EventColumnsBar carries the Event-breakdown toggle AND the unmapped
          badge together (they are not separately exported), so the breakdown
          cannot be on screen while the count of conversions it fails to explain
          is hidden. It takes the same `block` the columns came from, so the two
          cannot describe different responses. It sits OUTSIDE the empty state: a
          wholly unmapped conversion resolves to no stage, so it appears in no
          row and a range whose table is empty can still have strays worth
          seeing. On a fetch ERROR there is nothing to describe — the response is
          cleared, so the block is empty and the bar renders nothing. */}
      <EventColumnsBar block={block} onShowEventsChange={(v) => updateFilters({ showEvents: v })} />

      {fetchError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">
            Couldn&apos;t load reports: {fetchError}
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={refetch}>
            Retry
          </Button>
        </div>
      ) : !listApi.isLoading && data.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed py-16 text-center">
          <BarChart3 className="size-12 text-muted-foreground/40" aria-hidden />
          <div className="space-y-1">
            <p className="text-sm font-medium">No results in this range</p>
            <p className="text-sm text-muted-foreground">
              Keitaro data appears here once a tracked campaign gets clicks. Try a
              wider date range
              {canRefresh ? " or refresh from Keitaro" : ""}.
            </p>
          </div>
        </div>
      ) : (
        <DataTable<ReportRow>
          data={data}
          columns={columns}
          isLoading={listApi.isLoading}
          pageIndex={filters.page}
          pageSize={filters.pageSize}
          totalCount={totalCount}
          onPageChange={(p) => updateFilters({ page: p })}
          onPageSizeChange={(s) => updateFilters({ pageSize: s, page: 0 })}
          sortBy={filters.sortBy || null}
          sortDir={filters.sortDir}
          onSortChange={(by, dir) =>
            updateFilters({ sortBy: by ?? "revenue", sortDir: dir, page: 0 })
          }
        />
      )}

      {isAuthLoading ? (
        <p className="sr-only" aria-live="polite">
          Loading…
        </p>
      ) : null}
    </div>
  );
}
