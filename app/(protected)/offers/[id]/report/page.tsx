"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, RefreshCw, Download, AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import type {
  RawMetrics,
  GroupRawRow,
  OfferTotals,
} from "@/lib/reporting/offer-group-report";

type ReportResponse = {
  offerName: string;
  rows: GroupRawRow[];
  offerTotals: OfferTotals;
  orgBenchmark: RawMetrics;
  benchmarkHasManual: boolean;
  breakEvenPer1k: number | null;
  unattributedSends: number;
  refreshedAt: string | null;
};

// ---- formatting ----
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const int = new Intl.NumberFormat("en-US");
const fmtUsd = (n: number | null) => (n == null ? "—" : usd.format(n));

// Staleness thresholds for the "Data as of" line. The refresh cron runs twice
// daily (05:00 / 20:00 UTC), so the worst NORMAL age — just before the later
// run, having last refreshed at 05:00 — is 15h. Anything past 16h means a run
// was missed; past 26h means two were.
//
// This matters because the failure path is already covered: a refresh that
// throws alerts and returns 500. What nothing catches from the page's side is
// the job never being invoked, which leaves the previous numbers on screen,
// internally consistent and arbitrarily old. A bare timestamp does not carry
// that — 3 days ago and 6 hours ago render identically — so the age is stated
// and flagged rather than left for the reader to compute.
// Rows whose clicks mix a deduplicated contact count with Keitaro visit counts
// (manual-mode stages mint no links, so there is no set to deduplicate). Since
// migration 0132 this can only occur on the offer footer and the org benchmark:
// a group row is built from per-recipient rows, and every manual-fallback visit
// in this data sits on a stage that has none. Verified, not assumed -- of 938
// sent stages, the 22 with sends but no clickers all have zero visits.
function ManualMix() {
  return (
    <span
      title="Includes manual-mode stages. Their clicks are Keitaro visit counts, not deduplicated contacts, so this figure mixes the two."
      className="ml-1.5 rounded bg-amber-500/10 px-1 py-0.5 text-[10px] font-medium text-amber-700 align-middle dark:text-amber-500"
    >
      +manual
    </span>
  );
}

const STALE_WARN_HOURS = 16;
const STALE_ALERT_HOURS = 26;

function refreshAge(refreshedAt: string | null): {
  hours: number | null;
  level: "fresh" | "warn" | "alert";
  note: string | null;
} {
  if (!refreshedAt) {
    return { hours: null, level: "alert", note: "never refreshed" };
  }
  const hours = (Date.now() - new Date(refreshedAt).getTime()) / 3_600_000;
  if (hours > STALE_ALERT_HOURS) {
    return { hours, level: "alert", note: `${Math.floor(hours)}h old — at least two refreshes missed` };
  }
  if (hours > STALE_WARN_HOURS) {
    return { hours, level: "warn", note: `${Math.floor(hours)}h old — a refresh was missed` };
  }
  return { hours, level: "fresh", note: null };
}
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
  // TIME BASIS — this report applies NO date filter. offer_report_campaign_econ
  // has no date dimension, so every economics column here is ALL TIME. That is
  // stated in the headers rather than left to be inferred: the other reporting
  // screens show a lifetime figure AND a period figure, and a bare "EPC" here
  // would look like the same thing while meaning only one of them.
  //
  // Labelling only, deliberately. Adding a date dimension means another
  // migration across two matviews (the group one already fans out over
  // contact_contact_groups) plus a refresh cron that has no error handling, and
  // no user has asked for the filter — the gap came from an internal audit.
  // Tracked, with the case both ways, on ClickUp 869egyapn.
  { key: "group_name", label: "Group", numeric: false },
  { key: "sends", label: "Sends (all time)", numeric: true },
  { key: "rpm", label: "RPM (all time)", numeric: true },
  { key: "net_rpm", label: "Net RPM (all time)", numeric: true },
  { key: "epc", label: "EPC (all time)", numeric: true },
  { key: "sales", label: "Sales (all time)", numeric: true },
  { key: "oo_pct", label: "Opt-out % (all time)", numeric: true },
  { key: "net_profit", label: "Net profit (all time)", numeric: true },
  { key: "sent_7d", label: "Sent 7d", numeric: true },
  { key: "sent_30d", label: "Sent 30d", numeric: true },
  { key: "sent_90d", label: "Sent 90d", numeric: true },
  { key: "fresh_pool", label: "Fresh pool", numeric: true },
];

type ViewRow = GroupRawRow & Derived;

// ---- color helpers (pure, module scope) ----
function netRpmClass(v: number | null, breakEven: number | null) {
  return v == null || breakEven == null
    ? ""
    : v >= breakEven
      ? "text-emerald-600"
      : "text-destructive";
}
function ooClass(v: number | null) {
  return v == null ? "" : v <= 2 ? "text-emerald-600" : v <= 3 ? "text-amber-600" : "text-destructive";
}

function MetricCells({ m, isGroup, breakEven }: { m: RawMetrics & Derived; isGroup: boolean; breakEven: number | null }) {
  return (
    <>
      <td className="px-3 py-2 text-right tabular-nums">{fmtInt(m.sends)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(m.rpm)}</td>
      <td className={`px-3 py-2 text-right tabular-nums ${netRpmClass(m.net_rpm, breakEven)}`}>{fmtUsd(m.net_rpm)}</td>
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
  const staleness = refreshAge(data?.refreshedAt ?? null);
  const offerTotal = data ? { ...data.offerTotals, ...derive(data.offerTotals) } : null;
  const benchmark = data ? { ...data.orgBenchmark, ...derive(data.orgBenchmark) } : null;

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
      ...(offerTotal ? [line("This offer · all groups", offerTotal)] : []),
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `offer-${offerId}-group-report.csv`; a.click();
    URL.revokeObjectURL(url);
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
          {data && staleness.level !== "fresh" ? (
            <p
              className={`mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${
                staleness.level === "alert"
                  ? "bg-destructive/10 text-destructive"
                  : "bg-amber-500/10 text-amber-700 dark:text-amber-500"
              }`}
            >
              <AlertTriangle className="size-3.5 shrink-0" />
              Stale: {staleness.note}. These numbers are a snapshot, not live.
            </p>
          ) : null}
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
                <td className="px-3 py-2">
                  All offers (org-wide)
                  {data?.benchmarkHasManual ? <ManualMix /> : null}
                </td>
                <MetricCells m={benchmark} isGroup={false} breakEven={breakEven} />
              </tr>
            ) : null}
            {sorted.map((r) => (
              <tr key={r.group_id} className="border-t">
                <td className="px-3 py-2">{r.group_name}</td>
                <MetricCells m={r} isGroup breakEven={breakEven} />
              </tr>
            ))}
            {offerTotal ? (
              <tr className="border-t bg-muted/30 font-medium">
                <td className="px-3 py-2">
                  This offer · all groups
                  {data?.offerTotals.has_manual_stages ? <ManualMix /> : null}
                </td>
                <MetricCells m={offerTotal} isGroup={false} breakEven={breakEven} />
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

      {data && data.unattributedSends > 0 ? (
        <p className="text-xs text-muted-foreground">
          <strong>{fmtInt(data.unattributedSends)} sends</strong>{" "}
          ({((data.unattributedSends / Math.max(data.offerTotals.sends, 1)) * 100).toFixed(1)}%)
          could not be attributed to a group — some were recorded outside the
          app with no per-recipient detail, others came from a non-tracked
          campaign or a campaign whose targeted groups didn’t include the
          recipient — so they are in the offer total but not in any group row.
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Every metric is counted <em>per recipient</em>: a group row covers the
        messages actually sent to contacts in that group. Because a contact can
        belong to several groups, <strong>the count and money columns do not add
        up to the offer total</strong> — the same person is one send on the offer row and one send
        in each of their groups. “Sent last 7/30/90d” and “Fresh pool” count every
        in-app send (tracked or manual link mode); sends performed entirely outside
        the app aren’t included anywhere except the offer total.
      </p>
    </div>
  );
}
