"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, RefreshCw, Download } from "lucide-react";

import {
  type Derived,
  derive,
  downloadCsv,
  fmtInt,
  fmtNum,
  fmtPct,
  fmtUsd,
  ManualMix,
  netRpmClass,
  ooClass,
  StaleBanner,
} from "@/components/reports/report-metrics";
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

type SortKey =
  | "group_name" | "sends" | "rpm" | "net_rpm" | "epc" | "sales" | "pending_revenue"
  | "oo_pct" | "net_profit" | "sent_7d" | "sent_30d" | "sent_90d" | "fresh_pool";

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  // TIME BASIS — this report applies NO date filter. offer_report_campaign_econ
  // has no date dimension, so every economics column here is ALL TIME. That is
  // stated in the headers rather than left to be inferred: the other reporting
  // screens show a lifetime figure AND a period figure, and a bare "EPC" here
  // would look like the same thing while meaning only one of them.
  //
  // Labelling only, deliberately. Adding a date dimension means another
  // migration across three matviews (the group one already fans out over
  // contact_contact_groups) plus reworking a refresh cron that already has
  // error handling (try/catch, a Tier-1 Telegram alert, a 500, and duration
  // logging — see app/api/cron/refresh-offer-group-report/route.ts), and no
  // user has asked for the filter — the gap came from an internal audit.
  // Tracked, with the case both ways, on ClickUp 869egyapn.
  { key: "group_name", label: "Group", numeric: false },
  { key: "sends", label: "Sends (all time)", numeric: true },
  { key: "rpm", label: "RPM (all time)", numeric: true },
  { key: "net_rpm", label: "Net RPM (all time)", numeric: true },
  { key: "epc", label: "EPC (all time)", numeric: true },
  { key: "sales", label: "Sales (all time)", numeric: true },
  { key: "pending_revenue", label: "Pending $ (all time)", numeric: true },
  { key: "oo_pct", label: "Opt-out % (all time)", numeric: true },
  { key: "net_profit", label: "Net profit (all time)", numeric: true },
  { key: "sent_7d", label: "Sent 7d (this offer)", numeric: true },
  { key: "sent_30d", label: "Sent 30d (this offer)", numeric: true },
  { key: "sent_90d", label: "Sent 90d (this offer)", numeric: true },
  { key: "fresh_pool", label: "Fresh pool", numeric: true },
];

type ViewRow = GroupRawRow & Derived;

// "read low" / "read high" / "match" is derived from the actual ratio, never
// assumed: attributable_revenue/attributable_sales and revenue/sales are not
// a whole-and-part pair (different sources, not a subset — see the comment on
// OfferTotals in lib/reporting/offer-group-report.ts), so a coverage figure
// above 100% is representable and does happen.
function coverageWord(pct: number): string {
  if (pct > 100) return "read high";
  if (pct < 100) return "read low";
  return "match exactly";
}

function MetricCells({ m, isGroup, breakEven }: { m: RawMetrics & Derived & { pending_revenue?: number }; isGroup: boolean; breakEven: number | null }) {
  return (
    <>
      <td className="px-3 py-2 text-right tabular-nums">{fmtInt(m.sends)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(m.rpm)}</td>
      <td className={`px-3 py-2 text-right tabular-nums ${netRpmClass(m.net_rpm, breakEven)}`}>{fmtUsd(m.net_rpm)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(m.epc)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{fmtInt(m.sales)}</td>
      {/* Pending is approved revenue's sibling: a held payout, shown so it is
          visible without ever being added into Revenue / RPM / EPC / net profit.
          The org benchmark row has no pending figure of its own (its matview is
          the Keitaro stage-day aggregate), so it renders "—". */}
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
        {m.pending_revenue == null ? "—" : fmtUsd(m.pending_revenue)}
      </td>
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
  const offerTotal = data
    ? {
        ...data.offerTotals,
        ...derive(data.offerTotals),
        pending_revenue: data.offerTotals.attributable_pending_revenue,
      }
    : null;
  const benchmark = data ? { ...data.orgBenchmark, ...derive(data.orgBenchmark) } : null;

  // Group rows compute revenue/sales per recipient from the conversion_events
  // ledger (migration 0183: an is_purchase event type for Sales, counts_revenue
  // + status 'approved' for Revenue); the footer and benchmark use Keitaro's
  // per-stage aggregate instead (see attributable_revenue/attributable_sales on
  // offer_report_offer_totals_mv, migration 0132), so coverage is usually <100%
  // and a group row's RPM/EPC/Net RPM usually reads a little low next to the
  // footer/benchmark beside it
  // — this makes that gap visible instead of silent. Revenue and sales are
  // guarded against a zero denominator independently (each can be zero while
  // the other is not), and each is rendered as its own conditional clause
  // below for the same reason — an offer with sales and zero revenue (or vice
  // versa) still has something to show.
  const revenueCoveragePct =
    data && data.offerTotals.revenue > 0
      ? (data.offerTotals.attributable_revenue / data.offerTotals.revenue) * 100
      : null;
  const salesCoveragePct =
    data && data.offerTotals.sales > 0
      ? (data.offerTotals.attributable_sales / data.offerTotals.sales) * 100
      : null;

  const coverageParts = [
    revenueCoveragePct != null
      ? `${fmtPct(revenueCoveragePct)} of this offer’s revenue (${coverageWord(revenueCoveragePct)})`
      : null,
    salesCoveragePct != null
      ? `${fmtPct(salesCoveragePct)} of sales (${coverageWord(salesCoveragePct)})`
      : null,
  ].filter((p): p is string => p != null);

  function toggleSort(key: SortKey) {
    if (key === sortBy) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortBy(key); setSortDir(key === "group_name" ? "asc" : "desc"); }
  }

  function exportCsv() {
    if (!data) return;
    const header = COLUMNS.map((c) => c.label);
    const line = (label: string, m: RawMetrics & Derived) => [
      label, m.sends, fmtNum(m.rpm), fmtNum(m.net_rpm), fmtNum(m.epc), m.sales,
      "pending_revenue" in m ? fmtNum((m as { pending_revenue: number }).pending_revenue) : "",
      fmtNum(m.oo_pct), m.net_profit.toFixed(2),
      "sent_7d" in m ? (m as ViewRow).sent_7d : "",
      "sent_30d" in m ? (m as ViewRow).sent_30d : "",
      "sent_90d" in m ? (m as ViewRow).sent_90d : "",
      "fresh_pool" in m ? (m as ViewRow).fresh_pool : "",
    ];
    downloadCsv(`offer-${offerId}-group-report.csv`, [
      header,
      ...(benchmark ? [line("All offers (org-wide)", benchmark as ViewRow)] : []),
      ...sorted.map((r) => line(r.group_name, r)),
      ...(offerTotal ? [line("This offer · all groups", offerTotal)] : []),
    ]);
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
          {data ? <StaleBanner refreshedAt={data.refreshedAt} /> : null}
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

      {data && data.rows.length > 0 && coverageParts.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Group rows cover {coverageParts.join(" and ")} on a per-recipient
          basis; the footer and benchmark beside them use the provider’s
          per-stage totals instead.
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        <strong>Group rows</strong> are counted <em>per recipient</em>: each row
        covers the messages actually sent to contacts in that group. The offer
        footer and org benchmark use a different, campaign-grain basis instead —
        sends are counted per campaign (tracked → stage_sends count, manual →
        recorded sms_count), and revenue/sales come from the provider’s
        per-stage totals, not individual recipients. Because a contact can
        belong to several groups, <strong>the count and money columns do not
        add up to the offer total</strong> — the same send is counted once in
        each of that contact’s group rows. “Sent last 7/30/90d” only counts
        tracked-campaign sends to this offer’s targeted groups; “Fresh pool”
        counts across every offer and both link modes, independent of
        tracking.
      </p>
    </div>
  );
}
