"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, RefreshCw, Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";

type RawMetrics = {
  sends: number; revenue: number; sales: number; clicks: number; cost: number; optouts: number;
};
type GroupRawRow = RawMetrics & {
  group_id: number; group_name: string;
  sent_7d: number; sent_30d: number; sent_90d: number; fresh_pool: number;
};
type ReportResponse = {
  offerName: string;
  rows: GroupRawRow[];
  offerTotals: RawMetrics;
  orgBenchmark: RawMetrics;
  breakEvenPer1k: number | null;
  refreshedAt: string | null;
};

// ---- formatting ----
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const int = new Intl.NumberFormat("en-US");
const fmtUsd = (n: number | null) => (n == null ? "—" : usd.format(n));
const fmtInt = (n: number) => int.format(n);
const fmtNum = (n: number | null, dp = 2) => (n == null ? "—" : n.toFixed(dp));
const fmtPct = (n: number | null) => (n == null ? "—" : `${n.toFixed(2)}%`);

// ---- derived ratios (uniform for group rows, offer total, benchmark) ----
type Derived = { rpm: number | null; net_rpm: number | null; epc: number | null; net_profit: number; oo_pct: number | null };
function derive(m: RawMetrics): Derived {
  const rpm = m.sends > 0 ? (m.revenue / m.sends) * 1000 : null;
  const net_rpm = m.sends > 0 ? ((m.revenue - m.cost) / m.sends) * 1000 : null;
  const epc = m.clicks > 0 ? m.revenue / m.clicks : null;
  const oo_pct = m.sends > 0 ? (m.optouts / m.sends) * 100 : null;
  return { rpm, net_rpm, epc, net_profit: m.revenue - m.cost, oo_pct };
}

type SortKey =
  | "group_name" | "sends" | "rpm" | "net_rpm" | "epc" | "sales"
  | "oo_pct" | "net_profit" | "sent_7d" | "sent_30d" | "sent_90d" | "fresh_pool";

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "group_name", label: "Group", numeric: false },
  { key: "sends", label: "Sends", numeric: true },
  { key: "rpm", label: "RPM", numeric: true },
  { key: "net_rpm", label: "Net RPM", numeric: true },
  { key: "epc", label: "EPC", numeric: true },
  { key: "sales", label: "Sales", numeric: true },
  { key: "oo_pct", label: "Opt-out %", numeric: true },
  { key: "net_profit", label: "Net profit", numeric: true },
  { key: "sent_7d", label: "Sent 7d", numeric: true },
  { key: "sent_30d", label: "Sent 30d", numeric: true },
  { key: "sent_90d", label: "Sent 90d", numeric: true },
  { key: "fresh_pool", label: "Fresh pool", numeric: true },
];

type ViewRow = GroupRawRow & Derived;

export default function OfferGroupReportPage() {
  const params = useParams<{ id: string }>();
  const offerId = params.id;
  const api = useApiCall<ReportResponse>();
  const [data, setData] = useState<ReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>("net_rpm");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const load = useCallback(async () => {
    setError(null);
    const res = await api.execute(`/api/offers/${offerId}/report`);
    if (res.ok) setData(res.data);
    else setError(res.error);
  }, [api.execute, offerId]);

  useEffect(() => { void load(); }, [load]);

  const viewRows: ViewRow[] = useMemo(
    () => (data?.rows ?? []).map((r) => ({ ...r, ...derive(r) })),
    [data],
  );

  const sorted = useMemo(() => {
    const rows = [...viewRows];
    rows.sort((a, b) => {
      let cmp: number;
      if (sortBy === "group_name") cmp = a.group_name.localeCompare(b.group_name);
      else {
        const av = a[sortBy] as number | null;
        const bv = b[sortBy] as number | null;
        // nulls sort last regardless of direction
        if (av == null && bv == null) cmp = 0;
        else if (av == null) return 1;
        else if (bv == null) return -1;
        else cmp = av - bv;
      }
      if (cmp === 0) cmp = a.group_id - b.group_id;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [viewRows, sortBy, sortDir]);

  const breakEven = data?.breakEvenPer1k ?? null;
  const offerTotal = data ? { ...data.offerTotals, ...derive(data.offerTotals) } : null;
  const benchmark = data ? { ...data.orgBenchmark, ...derive(data.orgBenchmark) } : null;

  const netRpmClass = (v: number | null) =>
    v == null || breakEven == null
      ? ""
      : v >= breakEven
        ? "text-emerald-600"
        : "text-destructive";
  const ooClass = (v: number | null) =>
    v == null ? "" : v <= 2 ? "text-emerald-600" : v <= 3 ? "text-amber-600" : "text-destructive";

  function toggleSort(key: SortKey) {
    if (key === sortBy) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortBy(key); setSortDir(key === "group_name" ? "asc" : "desc"); }
  }

  function exportCsv() {
    if (!data) return;
    const header = COLUMNS.map((c) => c.label);
    const line = (label: string, m: RawMetrics & Derived) => [
      label, m.sends, fmtNum(m.rpm), fmtNum(m.net_rpm), fmtNum(m.epc), m.sales,
      fmtNum(m.oo_pct), m.net_profit.toFixed(2),
      "sent_7d" in m ? (m as ViewRow).sent_7d : "",
      "sent_30d" in m ? (m as ViewRow).sent_30d : "",
      "sent_90d" in m ? (m as ViewRow).sent_90d : "",
      "fresh_pool" in m ? (m as ViewRow).fresh_pool : "",
    ];
    const rows = [
      header,
      ...(benchmark ? [line("All offers (org-wide)", benchmark as ViewRow)] : []),
      ...sorted.map((r) => line(r.group_name, r)),
      ...(offerTotal ? [line("This offer · all groups", offerTotal as ViewRow)] : []),
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `offer-${offerId}-group-report.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  function MetricCells({ m, isGroup }: { m: RawMetrics & Derived; isGroup: boolean }) {
    return (
      <>
        <td className="px-3 py-2 text-right tabular-nums">{fmtInt(m.sends)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(m.rpm)}</td>
        <td className={`px-3 py-2 text-right tabular-nums ${netRpmClass(m.net_rpm)}`}>{fmtUsd(m.net_rpm)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(m.epc)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{fmtInt(m.sales)}</td>
        <td className={`px-3 py-2 text-right tabular-nums ${ooClass(m.oo_pct)}`}>{fmtPct(m.oo_pct)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(m.net_profit)}</td>
        <td className="px-3 py-2 text-right tabular-nums">{isGroup ? fmtInt((m as ViewRow).sent_7d) : "—"}</td>
        <td className="px-3 py-2 text-right tabular-nums">{isGroup ? fmtInt((m as ViewRow).sent_30d) : "—"}</td>
        <td className="px-3 py-2 text-right tabular-nums">{isGroup ? fmtInt((m as ViewRow).sent_90d) : "—"}</td>
        <td className="px-3 py-2 text-right tabular-nums">{isGroup ? fmtInt((m as ViewRow).fresh_pool) : "—"}</td>
      </>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Link href="/offers" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
            <ArrowLeft className="size-4" /> Offers
          </Link>
          <h1 className="text-xl font-semibold">
            Group Report{data ? ` — ${data.offerName}` : ""}
          </h1>
          <p className="text-xs text-muted-foreground">
            Data as of {data ? formatCampaignDateTime(data.refreshedAt) : "…"}
            {breakEven != null ? ` · break-even ${fmtUsd(breakEven)}/1k` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={api.isLoading}>
            <RefreshCw className={`size-4 ${api.isLoading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!data}>
            <Download className="size-4" /> CSV
          </Button>
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  onClick={() => toggleSort(c.key)}
                  className={`cursor-pointer select-none px-3 py-2 font-medium ${c.numeric ? "text-right" : "text-left"}`}
                >
                  {c.label}{sortBy === c.key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {benchmark ? (
              <tr className="border-t bg-muted/30 font-medium">
                <td className="px-3 py-2">All offers (org-wide)</td>
                <MetricCells m={benchmark} isGroup={false} />
              </tr>
            ) : null}
            {sorted.map((r) => (
              <tr key={r.group_id} className="border-t">
                <td className="px-3 py-2">{r.group_name}</td>
                <MetricCells m={r} isGroup />
              </tr>
            ))}
            {offerTotal ? (
              <tr className="border-t bg-muted/30 font-medium">
                <td className="px-3 py-2">This offer · all groups</td>
                <MetricCells m={offerTotal} isGroup={false} />
              </tr>
            ) : null}
            {data && sorted.length === 0 ? (
              <tr className="border-t">
                <td colSpan={COLUMNS.length} className="px-3 py-6 text-center text-muted-foreground">
                  No group data for this offer yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        A campaign targeting multiple groups is counted fully in each group, so group
        rows may sum to more than the org-wide total. “Sent last 7/30/90d” and “Fresh
        pool” count every in-app send (tracked or manual link mode); sends performed
        entirely outside the app (count-only, no per-recipient record) aren’t included.
      </p>
    </div>
  );
}
