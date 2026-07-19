"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BarChart3, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/data-table";
import { useAuth } from "@/components/protected/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CAMPAIGN_TIMEZONE_LABEL } from "@/lib/campaign-timezone";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";

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
  opt_outs: number;
  total_sent: number;
  opt_out_rate: number;
  clickers: number;
  click_rate: number;
  offer_redirect: number;
  redirect_rate: number;
  sales: number;
  sales_cr: number;
  revenue: number;
  cost: number;
  epc: number;
  profit: number;
};

type Totals = Omit<
  ReportRow,
  | "stage_id"
  | "campaign_id"
  | "campaign_name"
  | "stage_number"
  | "stage_name"
  | "stage_tracking_id"
  | "stage_count"
>;

type GroupBy = "stage" | "campaign";

type ReportResponse = {
  data: ReportRow[];
  totalCount: number;
  totals: Totals;
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

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
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
  const [totalCount, setTotalCount] = useState(0);
  const [fetchError, setFetchError] = useState<string | null>(null);
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
        setTotalCount(result.data.totalCount);
      } else {
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

  const columns = useMemo<ColumnDef<ReportRow>[]>(() => {
    const campaignCol: ColumnDef<ReportRow> = {
      id: "campaign_name",
      header: "Campaign",
      enableSorting: true,
      cell: ({ row }) => (
        <Link
          href={`/campaigns/${row.original.campaign_id}`}
          className="font-medium text-primary hover:underline"
        >
          {row.original.campaign_name}
        </Link>
      ),
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
        id: "clickers",
        header: "Clickers",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums">{fmtInt(row.original.clickers)}</span>
        ),
      },
      {
        id: "click_rate",
        header: "CR, %",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {fmtPct(row.original.click_rate)}
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
            {fmtPct(row.original.redirect_rate)}
          </span>
        ),
      },
      {
        id: "sales",
        header: "Sales",
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
        id: "cost",
        header: "Cost",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {fmtUsd(row.original.cost)}
          </span>
        ),
      },
      {
        id: "epc",
        header: "EPC",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="tabular-nums">{fmtUsd(row.original.epc)}</span>
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
    return [campaignCol, stageCol, ...rest];
  }, [filters.groupBy]);

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
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
          <StatCard label="Clickers" value={fmtInt(totals.clickers)} />
          <StatCard
            label="Offer Redirect"
            value={fmtInt(totals.offer_redirect)}
          />
          <StatCard label="Sales" value={fmtInt(totals.sales)} />
          <StatCard label="Revenue" value={fmtUsd(totals.revenue)} />
          <StatCard label="Cost" value={fmtUsd(totals.cost)} />
          <StatCard label="Profit" value={fmtUsd(totals.profit)} />
          <StatCard label="Avg Opt-out" value={fmtPct(totals.opt_out_rate)} />
        </div>
      ) : null}

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
