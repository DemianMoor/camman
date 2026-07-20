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

interface DerivedRow extends PerfRow {
  opt_out_rate: number; // opt_outs / sent
  click_rate: number; // clickers / sent (CR)
  redirect_rate: number; // redirects / clickers
  sales_cr: number; // sales / redirects
  epc: number; // revenue / redirects
  profit: number; // revenue - cost
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
    epc: rate(r.revenue, r.redirects),
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

type Col = {
  id: keyof DerivedRow;
  header: string;
  kind: "count" | "pct" | "usd" | "profit";
  muted?: boolean;
};
// Full metric set for number/offer/sequence/group — mirrors the Overview tab.
const FULL_COLS: Col[] = [
  { id: "sent", header: "Sent", kind: "count" },
  { id: "opt_outs", header: "Opt-outs", kind: "count", muted: true },
  { id: "opt_out_rate", header: "OptOut %", kind: "pct", muted: true },
  { id: "clickers", header: "Clickers", kind: "count" },
  { id: "click_rate", header: "CR %", kind: "pct", muted: true },
  { id: "redirects", header: "Redirects", kind: "count" },
  { id: "redirect_rate", header: "Redir %", kind: "pct", muted: true },
  { id: "sales", header: "Sales", kind: "count" },
  { id: "sales_cr", header: "Sales CR", kind: "pct", muted: true },
  { id: "revenue", header: "Revenue", kind: "usd" },
  { id: "cost", header: "Cost", kind: "usd", muted: true },
  { id: "epc", header: "EPC", kind: "usd" },
  { id: "profit", header: "Profit", kind: "profit" },
];
// Hourly is activity-time engagement — no send-time metrics (sent/cost/rates).
const HOURLY_COLS: Col[] = [
  { id: "clickers", header: "Clickers", kind: "count" },
  { id: "redirects", header: "Redirects", kind: "count" },
  { id: "sales", header: "Sales", kind: "count" },
  { id: "revenue", header: "Revenue", kind: "usd" },
  { id: "opt_outs", header: "Opt-outs", kind: "count", muted: true },
];

function fmtCell(v: number, kind: Col["kind"]): string {
  if (kind === "count") return fmtNum(v);
  if (kind === "pct") return fmtPct(v);
  return fmtUsd(v);
}

export function PerformanceReport({ dimension }: { dimension: ReportDimension }) {
  const isHourly = dimension === "hourly";
  const cols = isHourly ? HOURLY_COLS : FULL_COLS;

  const [filters, updateFilters, resetFilters] = usePersistedFilters<PerfFilters>(
    "reports.performance",
    { from: etDate(0), to: etDate(0), providerPhoneId: null, sortBy: "sent", sortDir: "desc" },
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
      // Pinned rows (hourly "Manual") always sort to the top.
      if (a.pinned && !b.pinned) return -1;
      if (b.pinned && !a.pinned) return 1;
      const av = a[key];
      const bv = b[key];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
    });
  }, [resp, filters.sortBy, filters.sortDir]);

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

      {totals ? (
        isHourly ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <StatCard label="Clickers" value={fmtInt(totals.clickers)} />
            <StatCard label="Redirects" value={fmtInt(totals.redirects)} />
            <StatCard label="Sales" value={fmtInt(totals.sales)} />
            <StatCard label="Revenue" value={fmtUsd(totals.revenue)} />
            <StatCard label="Opt-outs" value={fmtInt(totals.opt_outs)} />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            <StatCard label="Sent" value={fmtInt(totals.sent)} />
            <StatCard label="Opt-out %" value={fmtPct(rate(totals.opt_outs, totals.sent))} />
            <StatCard label="Clickers" value={fmtInt(totals.clickers)} />
            <StatCard label="Redirects" value={fmtInt(totals.redirects)} />
            <StatCard label="Sales" value={fmtInt(totals.sales)} />
            <StatCard label="Revenue" value={fmtUsd(totals.revenue)} />
            <StatCard label="Cost" value={fmtUsd(totals.cost)} />
            <StatCard label="Profit" value={fmtUsd(totals.revenue - totals.cost)} />
          </div>
        )
      ) : null}

      <p className="text-xs text-muted-foreground">
        {isHourly ? (
          <>
            Bucketed by <span className="font-medium">user-activity time</span> in {CAMPAIGN_TIMEZONE_LABEL} — clicks by
            click time, sales by conversion time, opt-outs by receipt time (internal event data; clicks won&apos;t equal
            the Keitaro count on Overview). Manual-campaign results have no per-event time and roll up into the pinned
            <span className="font-medium"> Manual</span> row.
          </>
        ) : (
          <>
            Sourced from the same Keitaro data as Overview, grouped by{" "}
            <span className="font-medium">{DIMENSION_LABEL[dimension].toLowerCase()}</span> — totals reconcile to the
            Overview tab. EPC = revenue ÷ offer redirects.
            {dimension === "group"
              ? " Each stage's totals are split across its contact groups (tracked: per contact across the groups used in the campaign; manual: by each group's audience share), so group rows sum back to the stage total. Values may show 2 decimals."
              : ""}
          </>
        )}
      </p>

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
              Try a wider date range{isHourly ? " — the hourly view is one ET day at a time" : ""}.
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
                      <td key={c.id} className={`whitespace-nowrap px-3 py-2 text-right tabular-nums ${cls}`}>
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
