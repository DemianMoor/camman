"use client";

import { Flag, Hourglass } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import type { DripDailyResults, ResultRow } from "@/lib/reporting/drip-daily-results";

// Drip campaign "Daily results" — table view (spec 2026-10-12, PR 4). The chart
// view is PR 5. All numbers come from /api/campaigns/[id]/daily-results, which
// reads only the rollup; every ratio is computed server-side from summed cells.

type Preset = "7d" | "30d" | "all" | "custom";
type Filters = {
  basis: "activity" | "cohort";
  breakdown: "none" | "stage" | "partner";
  preset: Preset;
  from: string;
  to: string;
};

const BASIS_HELP: Record<Filters["basis"], string> = {
  activity: "Activity: every event on the ET day it happened — sends, clicks, opt-outs, and sales on the day they were detected.",
  cohort: "Cohort: the leads admitted on each ET day, and everything those leads did since — late sales and follow-ups included.",
};

function etToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}
function addDays(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
function rangeFor(f: Filters): { from: string; to: string } {
  const today = etToday();
  if (f.preset === "7d") return { from: addDays(today, -6), to: today };
  if (f.preset === "30d") return { from: addDays(today, -29), to: today };
  if (f.preset === "all") return { from: "2020-01-01", to: today }; // the API clamps to the first day
  return { from: f.from || addDays(today, -6), to: f.to || today };
}

const int = (n: number | null) => (n == null ? "—" : n.toLocaleString("en-US"));
// Sub-dollar values (revenue per admitted lead is often $0.00xx) keep 4 decimals.
const usdFine = (n: number | null) =>
  n == null ? "—" : Math.abs(n) < 1 && n !== 0 ? `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(4)}` : usd(n);
const usd = (n: number | null) =>
  n == null ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
function dur(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 90) return `≈${Math.round(sec)}s`;
  if (sec < 5400) return `≈${(sec / 60).toFixed(1)}m`;
  return `≈${(sec / 3600).toFixed(1)}h`;
}
function dayLabel(ymd: string): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

interface Column {
  key: string;
  label: string;
  title: string;
  cell: (r: ResultRow) => string;
  cohortOnly?: boolean;
  activityOnly?: boolean;
}

const COLUMNS: Column[] = [
  { key: "la", label: "Leads admitted", title: "Leads admitted to this campaign, counted on the ET day they were received.", cell: (r) => int(r.leads_admitted), activityOnly: true },
  { key: "adm", label: "Admitted (same / carried)", title: "Leads admitted on this day: same-day vs carried over from an earlier day.", cell: (r) => (r.admitted == null ? "—" : `${int(r.admitted)} (${int(r.admitted_same_day)} / ${int(r.admitted_carried)})`) },
  { key: "first", label: "First sends", title: "First messages sent.", cell: (r) => int(r.first_sends) },
  { key: "fu", label: "Follow-ups", title: "Follow-up messages sent (and sends with no lead).", cell: (r) => int(r.followup_sends) },
  { key: "dlv", label: "Delivered %", title: "Delivered ÷ sends on numbers whose provider reports delivery. — when none do.", cell: (r) => pct(r.delivered_pct) },
  { key: "clk", label: "Clicks · per send", title: "Clean clicks (repeats count), and clicks per send.", cell: (r) => `${int(r.clicks)} · ${pct(r.ctr)}` },
  { key: "opt", label: "Opt-outs %", title: "STOP replies ÷ sends, dated by the reply.", cell: (r) => `${int(r.opt_outs)} · ${pct(r.opt_out_pct)}` },
  { key: "sal", label: "Sales · conv %", title: "Sales detected on this day; conversion = sales ÷ clicks.", cell: (r) => `${int(r.sales)} · ${pct(r.conv_pct)}` },
  { key: "cost", label: "Send cost", title: "Each send at its recorded rate, plus each opt-out reply at the rate of the send it answered.", cell: (r) => usd(r.send_cost) },
  { key: "look", label: "Lookup cost", title: "Admitted leads × the calibrated lookup rate (the partner report's). Slightly overstates: a cache hit cost nothing. Not attributable to a stage — on the campaign total only.", cell: (r) => usd(r.lookup_cost) },
  { key: "rev", label: "Revenue", title: "Approved revenue, dated by detection.", cell: (r) => usd(r.revenue) },
  { key: "pro", label: "Profit", title: "Revenue − send cost − lookup cost. On a stage row, before lookup cost.", cell: (r) => usd(r.profit) },
  { key: "roi", label: "ROI", title: "Profit ÷ (send cost + lookup cost), from summed money. — when there was no cost.", cell: (r) => pct(r.roi) },
  { key: "rpa", label: "Rev / admitted", title: "Revenue ÷ admitted leads in this cohort.", cell: (r) => usdFine(r.revenue_per_admitted), cohortOnly: true },
  { key: "lat", label: "Median lead→send", title: "Median time from the lead's arrival to its first message, leads routed on arrival only (≈, from a histogram).", cell: (r) => dur(r.median_latency_sec) },
];

export function DripDailyResults({ campaignId }: { campaignId: number }) {
  const [filters, update] = usePersistedFilters<Filters>("campaign.dailyResults", {
    basis: "activity",
    breakdown: "none",
    preset: "7d",
    from: "",
    to: "",
  });
  const api = useApiCall<DripDailyResults>();
  const execute = api.execute;
  const [data, setData] = useState<DripDailyResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const range = rangeFor(filters);

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({ basis: filters.basis, breakdown: filters.breakdown, from: range.from, to: range.to });
    execute(`/api/campaigns/${campaignId}/daily-results?${qs}`).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setData(r.data);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [campaignId, execute, filters.basis, filters.breakdown, range.from, range.to]);

  const cols = useMemo(
    () => COLUMNS.filter((c) => (filters.basis === "cohort" ? !c.activityOnly : !c.cohortOnly)),
    [filters.basis],
  );
  const shown = data && data.basis === filters.basis && data.breakdown === filters.breakdown ? data : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1.5">
          <Label>View</Label>
          <div className="flex h-9 items-center rounded-md border p-0.5">
            {(["activity", "cohort"] as const).map((b) => (
              <button
                key={b}
                type="button"
                title={BASIS_HELP[b]}
                onClick={() => update({ basis: b })}
                className={
                  "h-8 rounded px-3 text-sm capitalize transition-colors " +
                  (filters.basis === b ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")
                }
              >
                {b}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label>Range (ET days)</Label>
          <div className="flex h-9 items-center rounded-md border p-0.5">
            {([["7d", "7d"], ["30d", "30d"], ["all", "Since launch"], ["custom", "Custom"]] as const).map(([p, label]) => (
              <button
                key={p}
                type="button"
                onClick={() => update(p === "custom" ? { preset: p, from: range.from, to: range.to } : { preset: p })}
                className={
                  "h-8 rounded px-3 text-sm transition-colors " +
                  (filters.preset === p ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {filters.preset === "custom" ? (
          <div className="flex items-end gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="ddr-from">From</Label>
              <Input id="ddr-from" type="date" value={range.from} max={range.to} className="h-9 w-[150px]"
                onChange={(e) => e.target.value && update({ from: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ddr-to">To</Label>
              <Input id="ddr-to" type="date" value={range.to} min={range.from} max={etToday()} className="h-9 w-[150px]"
                onChange={(e) => e.target.value && update({ to: e.target.value })} />
            </div>
          </div>
        ) : null}
        <div className="grid gap-1.5">
          <Label>Breakdown</Label>
          <Select value={filters.breakdown} onValueChange={(v) => update({ breakdown: v as Filters["breakdown"] })}>
            <SelectTrigger className="h-9 w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="stage">By stage</SelectItem>
              <SelectItem value="partner">By partner</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <p className="text-xs text-muted-foreground" title={BASIS_HELP[filters.basis]}>
        {BASIS_HELP[filters.basis]}{" "}
        <span className="whitespace-nowrap">
          Older days updated nightly
          {shown?.freshness.fresh_as_of
            ? ` · today and yesterday as of ${formatCampaignDateTime(shown.freshness.fresh_as_of)}`
            : ""}
          .
        </span>
        {filters.basis === "cohort" && shown ? (
          <span className="whitespace-nowrap">
            {" "}
            <Hourglass className="inline size-3 align-[-1px]" aria-hidden /> = still maturing (younger than {shown.maturity_days} days).
          </span>
        ) : null}
      </p>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {!shown && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {shown ? (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm tabular-nums">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="sticky left-0 z-10 bg-muted px-3 py-2 font-medium">Day (ET)</th>
                {cols.map((c) => (
                  <th key={c.key} title={c.title} className="whitespace-nowrap px-3 py-2 text-right font-medium">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <Row label={`Total · ${dayLabel(shown.from)}–${dayLabel(shown.to)}`} row={shown.totals} cols={cols} strong />
              {shown.totals_groups.map((g) => (
                <Row key={`t-${g.key}`} label={g.label} row={g.row} cols={cols} depth={g.depth + 1} muted />
              ))}
              {shown.days.map((d) => (
                <Fragment key={d.day}>
                  <Row
                    label={dayLabel(d.day)}
                    row={d.row}
                    cols={cols}
                    markers={d.markers.map((m) => `${formatCampaignDateTime(m.at)} — ${m.text}`)}
                    maturing={d.maturing}
                  />
                  {d.groups.map((g) => (
                    <Row key={`${d.day}-${g.key}`} label={g.label} row={g.row} cols={cols} depth={g.depth + 1} />
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function Row({
  label, row, cols, strong, muted, depth = 0, markers = [], maturing,
}: {
  label: string;
  row: ResultRow;
  cols: Column[];
  strong?: boolean;
  muted?: boolean;
  depth?: number;
  markers?: string[];
  maturing?: boolean;
}) {
  return (
    <tr className={(strong ? "border-b-2 bg-muted/40 font-medium " : "border-b ") + (muted ? "bg-muted/20 " : "")}>
      <td
        className={"sticky left-0 z-10 whitespace-nowrap px-3 py-1.5 " + (strong ? "bg-muted" : "bg-background")}
        style={depth ? { paddingLeft: `${0.75 + depth * 1}rem` } : undefined}
      >
        <span className={depth ? "text-muted-foreground" : ""}>{label}</span>
        {markers.length > 0 ? (
          <span title={markers.join("\n")} className="ml-1.5 inline-flex align-[-2px] text-amber-600">
            <Flag className="size-3.5" aria-label={`${markers.length} change(s)`} />
          </span>
        ) : null}
        {maturing ? (
          <span title="Still maturing: late sales and follow-ups can still arrive for this cohort." className="ml-1.5 inline-flex align-[-2px] text-muted-foreground">
            <Hourglass className="size-3.5" aria-label="still maturing" />
          </span>
        ) : null}
      </td>
      {cols.map((c) => (
        <td key={c.key} className="whitespace-nowrap px-3 py-1.5 text-right">
          {c.cell(row)}
        </td>
      ))}
    </tr>
  );
}
