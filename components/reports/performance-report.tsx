"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart3 } from "lucide-react";

import { ProviderPhoneCell } from "@/components/provider-phone-cell";
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
  range: { from: string; to: string; timezone: string };
}

// A row with the read-time-derived ratios attached.
interface DerivedRow extends PerfRow {
  opt_out_rate: number;
  click_rate: number;
  redirect_rate: number;
  sales_rate: number;
  epc: number;
  profit: number;
}

type PerfFilters = {
  from: string;
  to: string;
  providerPhoneId: number | null;
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

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const fmtUsd = (n: number) => usd.format(n);
const fmtInt = (n: number) => n.toLocaleString();
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
const rate = (num: number, denom: number) => (denom > 0 ? num / denom : 0);

function derive(r: PerfRow): DerivedRow {
  return {
    ...r,
    opt_out_rate: rate(r.opt_outs, r.sent),
    click_rate: rate(r.clicks, r.sent),
    redirect_rate: rate(r.redirects, r.sent),
    sales_rate: rate(r.sales, r.sent),
    epc: rate(r.revenue, r.clicks),
    profit: r.revenue - r.cost,
  };
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

// Metric column config (right-aligned numerics). The label column is rendered
// separately (dimension-specific).
type NumericCol = {
  id: keyof DerivedRow;
  header: string;
  kind: "int" | "pct" | "usd" | "profit";
  muted?: boolean;
};
const NUMERIC_COLS: NumericCol[] = [
  { id: "sent", header: "Sent", kind: "int" },
  { id: "opt_outs", header: "Opt-outs", kind: "int", muted: true },
  { id: "opt_out_rate", header: "OptOut %", kind: "pct", muted: true },
  { id: "clicks", header: "Clickers", kind: "int" },
  { id: "click_rate", header: "CR %", kind: "pct", muted: true },
  { id: "redirects", header: "Redirects", kind: "int" },
  { id: "redirect_rate", header: "Redir %", kind: "pct", muted: true },
  { id: "sales", header: "Sales", kind: "int" },
  { id: "sales_rate", header: "Sales %", kind: "pct", muted: true },
  { id: "revenue", header: "Revenue", kind: "usd" },
  { id: "cost", header: "Cost", kind: "usd", muted: true },
  { id: "epc", header: "EPC", kind: "usd" },
  { id: "profit", header: "Profit", kind: "profit" },
];

function fmtCell(v: number, kind: NumericCol["kind"]): string {
  if (kind === "int") return fmtInt(v);
  if (kind === "pct") return fmtPct(v);
  return fmtUsd(v);
}

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
      to: isHourly ? filters.from : filters.to,
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

  const rows = useMemo<DerivedRow[]>(() => {
    const derived = (resp?.data ?? []).map(derive);
    const dir = filters.sortDir === "asc" ? 1 : -1;
    const key = filters.sortBy as keyof DerivedRow;
    return [...derived].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
    });
  }, [resp, filters.sortBy, filters.sortDir]);

  const totals = resp?.totals ?? null;
  const providers = resp?.providers ?? [];

  function toggleSort(id: string) {
    if (filters.sortBy === id) {
      updateFilters({ sortDir: filters.sortDir === "asc" ? "desc" : "asc" });
    } else {
      updateFilters({ sortBy: id, sortDir: "desc" });
    }
  }
  const sortIndicator = (id: string) =>
    filters.sortBy === id ? (filters.sortDir === "asc" ? " ▲" : " ▼") : "";

  function renderLabel(r: DerivedRow) {
    if (dimension === "number") {
      return (
        <ProviderPhoneCell
          providers={
            r.provider_name ? [{ name: r.provider_name, color: r.provider_color }] : []
          }
          phones={
            r.phone_number
              ? [{ phone_number: r.phone_number, number_type: r.number_type ?? undefined }]
              : []
          }
        />
      );
    }
    if (dimension === "group") {
      return (
        <span className="inline-flex items-center gap-1.5">
          <span
            className="size-2 rounded-full"
            style={{ backgroundColor: r.group_color ?? "#64748B" }}
          />
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
          <Label htmlFor="perf-from">{isHourly ? "Day" : "From"}</Label>
          <Input
            id="perf-from"
            type="date"
            value={filters.from}
            max={isHourly ? undefined : filters.to}
            onChange={(e) => updateFilters({ from: e.target.value })}
            className="h-9 w-[160px]"
          />
        </div>
        {!isHourly ? (
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
        ) : null}
        <div className="grid gap-1.5">
          <Label>Provider / number</Label>
          <Select
            value={filters.providerPhoneId == null ? "all" : String(filters.providerPhoneId)}
            onValueChange={(v) =>
              updateFilters({ providerPhoneId: v === "all" ? null : Number(v) })
            }
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

      {totals ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          <StatCard label="Sent" value={fmtInt(totals.sent)} />
          <StatCard label="Opt-out %" value={fmtPct(rate(totals.opt_outs, totals.sent))} />
          <StatCard label="Clickers" value={fmtInt(totals.clicks)} />
          <StatCard label="Redirects" value={fmtInt(totals.redirects)} />
          <StatCard label="Sales" value={fmtInt(totals.sales)} />
          <StatCard label="Revenue" value={fmtUsd(totals.revenue)} />
          <StatCard label="Cost" value={fmtUsd(totals.cost)} />
          <StatCard label="Profit" value={fmtUsd(totals.revenue - totals.cost)} />
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Grouped by <span className="font-medium">{DIMENSION_LABEL[dimension].toLowerCase()}</span>,
        bucketed by the send hour in {CAMPAIGN_TIMEZONE_LABEL}. Sales &amp; revenue are
        per-recipient attribution (~93% of the Keitaro total on the Overview tab); EPC = revenue ÷
        clickers.
        {dimension === "group"
          ? " A contact in multiple groups is counted in each — group rows can sum to more than the true total (shown in the totals above, which never double-count)."
          : ""}
      </p>

      {fetchError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">Couldn&apos;t load report: {fetchError}</p>
        </div>
      ) : !api.isLoading && rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed py-16 text-center">
          <BarChart3 className="size-12 text-muted-foreground/40" aria-hidden />
          <div className="space-y-1">
            <p className="text-sm font-medium">No sends in this range</p>
            <p className="text-sm text-muted-foreground">
              Try a wider date range{isHourly ? " — the hourly view is one ET day at a time" : ""}.
            </p>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left">
                <th className="px-3 py-2 font-medium">{DIMENSION_LABEL[dimension]}</th>
                {NUMERIC_COLS.map((c) => (
                  <th
                    key={c.id}
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
                  {NUMERIC_COLS.map((c) => {
                    const v = r[c.id] as number;
                    const cls =
                      c.kind === "profit"
                        ? v >= 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-destructive"
                        : c.muted
                          ? "text-muted-foreground"
                          : "";
                    return (
                      <td
                        key={c.id}
                        className={`whitespace-nowrap px-3 py-2 text-right tabular-nums ${cls}`}
                      >
                        {fmtCell(v, c.kind)}
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
