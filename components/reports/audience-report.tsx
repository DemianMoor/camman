"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";

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
import { SearchableSelect } from "@/components/searchable-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";
import type {
  AudienceGroupOption,
  AudienceGroupTotals,
  AudienceOfferRow,
  SentWindows,
} from "@/lib/reporting/audience-report";
import type { RawMetrics } from "@/lib/reporting/offer-group-report";

type ReportBody = {
  groupId: number;
  groupName: string;
  groupArchived: boolean;
  rows: AudienceOfferRow[];
  groupTotals: AudienceGroupTotals;
  orgBenchmark: RawMetrics;
  benchmarkHasManual: boolean;
  breakEvenPer1k: number | null;
  refreshedAt: string | null;
};

type AudienceResponse = { groups: AudienceGroupOption[]; report: ReportBody | null };

type SortKey =
  | "offer_name" | "sends" | "rpm" | "net_rpm" | "epc" | "sales"
  | "oo_pct" | "net_profit" | "sent_7d" | "sent_30d" | "sent_90d" | "fresh_pool";

// TIME BASIS — like the offer report, economics are ALL TIME: the matview has no
// date dimension (a recorded decision, see docs/04-features/epc-denominator.md).
const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "offer_name", label: "Offer", numeric: false },
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

type ViewRow = AudienceOfferRow & Derived;

const NUM = "px-3 py-2 text-right tabular-nums";

// `windows` / `freshPool` are null where the quantity has no meaning: the org
// benchmark has neither, and the group total has no fresh pool (that count is
// per offer).
function MetricCells({
  m,
  breakEven,
  windows,
  freshPool,
}: {
  m: RawMetrics & Derived;
  breakEven: number | null;
  windows: SentWindows | null;
  freshPool: number | null;
}) {
  return (
    <>
      <td className={NUM}>{fmtInt(m.sends)}</td>
      <td className={NUM}>{fmtUsd(m.rpm)}</td>
      <td className={`${NUM} ${netRpmClass(m.net_rpm, breakEven)}`}>{fmtUsd(m.net_rpm)}</td>
      <td className={NUM}>{fmtUsd(m.epc)}</td>
      <td className={NUM}>{fmtInt(m.sales)}</td>
      <td className={`${NUM} ${ooClass(m.oo_pct)}`}>{fmtPct(m.oo_pct)}</td>
      <td className={NUM}>{fmtUsd(m.net_profit)}</td>
      <td className={NUM}>{windows ? fmtInt(windows.sent_7d) : "—"}</td>
      <td className={NUM}>{windows ? fmtInt(windows.sent_30d) : "—"}</td>
      <td className={NUM}>{windows ? fmtInt(windows.sent_90d) : "—"}</td>
      <td className={NUM}>{freshPool == null ? "—" : fmtInt(freshPool)}</td>
    </>
  );
}

// /reports/audience — offer results for one contact group (ClickUp 869eydqn0).
// The selected group lives in ?group=<id>; page.tsx reads it server-side and
// passes it in, and picking a group rewrites the URL without a navigation.
export function AudienceReport({ initialGroupId }: { initialGroupId: number | null }) {
  const groupsApi = useApiCall<AudienceResponse>();
  const reportApi = useApiCall<AudienceResponse>();
  const [groups, setGroups] = useState<AudienceGroupOption[] | null>(null);
  const [groupId, setGroupId] = useState<number | null>(initialGroupId);
  const [report, setReport] = useState<ReportBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the Refresh button to re-fetch the same group's snapshot.
  const [reloadKey, setReloadKey] = useState(0);
  const [sortBy, setSortBy] = useState<SortKey>("net_rpm");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // The group whose report should be on screen. A slower response for a group
  // the user has already switched away from must not overwrite the newer one.
  const wanted = useRef<number | null>(initialGroupId);

  useEffect(() => {
    void (async () => {
      const res = await groupsApi.execute("/api/reports/audience");
      if (res.ok) setGroups(res.data.groups);
      else setError(res.error);
    })();
  }, [groupsApi.execute]);

  useEffect(() => {
    if (groupId == null) return;
    void (async () => {
      const res = await reportApi.execute(`/api/reports/audience?group_id=${groupId}`);
      if (wanted.current !== groupId) return;
      if (res.ok) {
        setReport(res.data.report);
        setError(null);
      } else {
        setReport(null);
        setError(res.error);
      }
    })();
  }, [reportApi.execute, groupId, reloadKey]);

  function pickGroup(value: string) {
    const id = Number(value);
    if (id === groupId) return;
    wanted.current = id;
    setGroupId(id);
    setReport(null);
    setError(null);
    window.history.replaceState(null, "", `?group=${id}`);
  }

  const viewRows: ViewRow[] = useMemo(
    () => (report?.rows ?? []).map((r) => ({ ...r, ...derive(r) })),
    [report],
  );

  const sorted = useMemo(() => {
    const rows = [...viewRows];
    rows.sort((a, b) => {
      let cmp: number;
      if (sortBy === "offer_name") cmp = a.offer_name.localeCompare(b.offer_name);
      else {
        const av = a[sortBy] as number | null;
        const bv = b[sortBy] as number | null;
        // nulls sort last regardless of direction
        if (av == null && bv == null) cmp = 0;
        else if (av == null) return 1;
        else if (bv == null) return -1;
        else cmp = av - bv;
      }
      if (cmp === 0) cmp = a.offer_id - b.offer_id;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [viewRows, sortBy, sortDir]);

  const options = useMemo(
    () =>
      (groups ?? []).map((g) => ({
        value: String(g.id),
        label: g.archived ? `${g.name} (archived)` : g.name,
      })),
    [groups],
  );

  const breakEven = report?.breakEvenPer1k ?? null;
  const benchmark = report ? { ...report.orgBenchmark, ...derive(report.orgBenchmark) } : null;
  const totals = report ? { ...report.groupTotals, ...derive(report.groupTotals) } : null;

  function toggleSort(key: SortKey) {
    if (key === sortBy) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortBy(key);
      setSortDir(key === "offer_name" ? "asc" : "desc");
    }
  }

  function exportCsv() {
    if (!report || !benchmark || !totals) return;
    const line = (
      label: string,
      m: RawMetrics & Derived,
      w: SentWindows | null,
      fresh: number | null,
    ) => [
      label, m.sends, fmtNum(m.rpm), fmtNum(m.net_rpm), fmtNum(m.epc), m.sales,
      fmtNum(m.oo_pct), m.net_profit.toFixed(2),
      w?.sent_7d ?? "", w?.sent_30d ?? "", w?.sent_90d ?? "", fresh ?? "",
    ];
    downloadCsv(`audience-group-${report.groupId}.csv`, [
      COLUMNS.map((c) => c.label),
      line("All offers · all groups (org-wide)", benchmark, null, null),
      ...sorted.map((r) =>
        line(r.offer_archived ? `${r.offer_name} (archived)` : r.offer_name, r, r, r.fresh_pool),
      ),
      line("This group · all offers", totals, report.groupTotals, null),
    ]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <SearchableSelect
            options={options}
            value={groupId == null ? null : String(groupId)}
            onChange={pickGroup}
            placeholder="Pick a contact group"
            searchPlaceholder="Search groups…"
            emptyMessage="No groups match"
            disabled={groups == null}
            className="w-72"
            fallbackLabel={report?.groupName}
            aria-label="Contact group"
          />
          {report ? (
            <p className="text-xs text-muted-foreground">
              Data as of {formatCampaignDateTime(report.refreshedAt)}
              {breakEven != null ? ` · break-even ${fmtUsd(breakEven)}/1k` : ""}
            </p>
          ) : null}
          {report ? <StaleBanner refreshedAt={report.refreshedAt} /> : null}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={groupId == null || reportApi.isLoading}
          >
            <RefreshCw className={`size-4 ${reportApi.isLoading ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!report}>
            <Download className="size-4" /> CSV
          </Button>
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {groupId == null && groups != null ? (
        <p className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
          {groups.length === 0
            ? "No contact group has report data yet."
            : "Pick a contact group to see how each offer has performed with it."}
        </p>
      ) : null}

      {groupId != null && !report && !error ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading…</p>
      ) : null}

      {report && benchmark && totals ? (
        <>
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
                      {c.label}
                      {sortBy === c.key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-t bg-muted/30 font-medium">
                  <td className="px-3 py-2">
                    All offers · all groups (org-wide)
                    {report.benchmarkHasManual ? <ManualMix /> : null}
                  </td>
                  <MetricCells m={benchmark} breakEven={breakEven} windows={null} freshPool={null} />
                </tr>
                {sorted.map((r) => (
                  <tr key={r.offer_id} className="border-t">
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5">
                        {r.offer_name}
                        {r.offer_archived ? <Badge variant="secondary">Archived</Badge> : null}
                      </span>
                    </td>
                    <MetricCells m={r} breakEven={breakEven} windows={r} freshPool={r.fresh_pool} />
                  </tr>
                ))}
                {sorted.length === 0 ? (
                  <tr className="border-t">
                    <td colSpan={COLUMNS.length} className="px-3 py-6 text-center text-muted-foreground">
                      No offer data for this group yet.
                    </td>
                  </tr>
                ) : null}
                <tr className="border-t bg-muted/30 font-medium">
                  <td className="px-3 py-2">This group · all offers</td>
                  <MetricCells m={totals} breakEven={breakEven} windows={report.groupTotals} freshPool={null} />
                </tr>
              </tbody>
            </table>
          </div>

          <div className="space-y-1 text-xs text-muted-foreground">
            <p>
              <strong>Offer rows</strong> count messages from tracked campaigns that
              targeted this group, sent to contacts in it. Sends from manual-link
              campaigns have no per-recipient record, so they can’t be attributed to
              a group and don’t appear here.
            </p>
            <p>
              <strong>This group · all offers</strong> counts each clicker and each
              opt-out once across every offer, so its clicks (the EPC denominator)
              and opt-outs are lower than the rows added up. Sends, revenue, sales
              and cost do add up.
            </p>
            <p>
              A contact in several groups is counted in each of those groups’
              reports, so groups don’t add up to the org-wide row — which is also
              built from campaign totals rather than individual recipients.
            </p>
            <p>
              <strong>Fresh pool</strong>: contacts in this group who can still be
              messaged and have never been sent that offer.
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}
