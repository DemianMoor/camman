"use client";

import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { LINE_METRICS, type LineMetric } from "@/components/drip/daily-results-metrics";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import type { DripDailyResults } from "@/lib/reporting/drip-daily-results";

// Drip "Daily results" chart (PR 5). Its own module so the tab can load it with
// next/dynamic (Recharts is ~360 KB) — same pattern as components/dashboard/chart-panel.tsx.
//
// Profit per ET day as bars; ONE line metric on a second axis (owner brief). With
// a breakdown, the bar is stacked by group in a FIXED colour order (the group's
// stable order — stage number / partner name — never its rank), folding past 4
// into "Other". Under By stage, admissions have no stage, so a "Lookup cost"
// segment makes each stack sum to the day's profit. Colours: validated categorical
// slots + a blue/red profit-loss pair, light and dark (app/globals.css --ddr-*).

const SLOTS = ["var(--ddr-1)", "var(--ddr-2)", "var(--ddr-3)", "var(--ddr-4)"];
const MAX_GROUPS = SLOTS.length;

const usd = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const usd2 = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
const pctFmt = (n: number) => `${(n * 100).toFixed(1)}%`;
const dayLabel = (ymd: string) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

type Point = Record<string, number | string | boolean | null | string[]>;

export function DripDailyResultsChart({ data, metric }: { data: DripDailyResults; metric: LineMetric }) {
  const m = LINE_METRICS[metric];
  const stacked = data.breakdown !== "none";
  // Stable group order = the API's order (stage number, lanes under parents /
  // partner name, Unattributed last). The first 4 keep their slot; the rest fold.
  const order = data.totals_groups.map((g) => ({ key: g.key, label: g.label }));
  const kept = order.slice(0, MAX_GROUPS);
  const folded = order.length > MAX_GROUPS;
  const lookupSeg = data.breakdown === "stage";

  const points: Point[] = [...data.days].reverse().map((d) => {
    const p: Point = {
      day: d.day,
      label: dayLabel(d.day),
      profit: d.row.profit,
      metric: m.pick(d.row),
      maturing: d.maturing,
      markers: d.markers.map((x) => `${formatCampaignDateTime(x.at)} — ${x.text}`),
    };
    if (stacked) {
      const byKey = new Map(d.groups.map((g) => [g.key, g.row.profit]));
      kept.forEach((g) => (p[g.key] = byKey.get(g.key) ?? 0));
      if (folded) p.__other = order.slice(MAX_GROUPS).reduce((a, g) => a + (byKey.get(g.key) ?? 0), 0);
      if (lookupSeg) p.__lookup = -(d.row.lookup_cost ?? 0);
    }
    return p;
  });

  // Legend text stays in ink; only the swatch carries the series colour.
  const legendItems: LegendItem[] = stacked
    ? [
        ...kept.map((g, i) => ({ label: g.label, color: SLOTS[i], kind: "box" as const })),
        ...(folded ? [{ label: "Other", color: "var(--ddr-neutral)", kind: "box" as const }] : []),
        ...(lookupSeg ? [{ label: "Lookup cost", color: "var(--ddr-neutral)", kind: "box" as const }] : []),
        { label: `${m.label} (right axis)`, color: "var(--ddr-line)", kind: "line" as const },
      ]
    : [
        { label: "Profit", color: "var(--ddr-profit)", kind: "box" as const },
        { label: "Loss", color: "var(--ddr-loss)", kind: "box" as const },
        { label: `${m.label} (right axis)`, color: "var(--ddr-line)", kind: "line" as const },
      ];

  const markerDays = points.filter((p) => (p.markers as string[]).length > 0).map((p) => p.label as string);

  return (
    <div className="space-y-2">
      <div className="h-[340px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          {/* stackOffset="sign": negative segments (losses, Lookup cost) stack DOWN from
              zero instead of being drawn back over the positive stack. */}
          <ComposedChart data={points} margin={{ top: 20, right: 8, bottom: 0, left: 8 }} barCategoryGap="20%" stackOffset="sign">
            <CartesianGrid vertical={false} stroke="var(--ddr-grid)" />
            <XAxis dataKey="label" tick={{ fontSize: 12, fill: "var(--ddr-ink)" }} tickLine={false} axisLine={{ stroke: "var(--ddr-grid)" }} />
            <YAxis
              yAxisId="money"
              tickFormatter={usd}
              tick={{ fontSize: 12, fill: "var(--ddr-ink)" }}
              tickLine={false}
              axisLine={false}
              width={64}
            />
            <YAxis
              yAxisId="metric"
              orientation="right"
              tickFormatter={(v: number) => (m.pct ? pctFmt(v) : v.toLocaleString("en-US"))}
              tick={{ fontSize: 12, fill: "var(--ddr-ink)" }}
              tickLine={false}
              axisLine={false}
              width={56}
            />
            <ReferenceLine yAxisId="money" y={0} stroke="var(--ddr-ink)" strokeOpacity={0.4} />
            {markerDays.map((x) => (
              <ReferenceLine key={x} yAxisId="money" x={x} stroke="var(--ddr-marker)" strokeDasharray="4 3" label={{ value: "⚑", position: "top", fill: "var(--ddr-marker)", fontSize: 12 }} />
            ))}
            <Tooltip content={<ChartTooltip metric={metric} stacked={stacked} groups={kept} folded={folded} lookup={lookupSeg} />} cursor={{ fill: "var(--ddr-grid)", fillOpacity: 0.35 }} />
            <Legend content={<ChartLegend items={legendItems} />} />
            {stacked ? (
              <>
                {kept.map((g, i) => (
                  <Bar key={g.key} yAxisId="money" dataKey={g.key} name={g.label} stackId="p" fill={SLOTS[i]} stroke="var(--ddr-surface)" strokeWidth={1}>
                    {points.map((p) => <Cell key={p.day as string} fillOpacity={p.maturing ? 0.45 : 1} />)}
                  </Bar>
                ))}
                {folded ? <Bar yAxisId="money" dataKey="__other" name="Other" stackId="p" fill="var(--ddr-neutral)" stroke="var(--ddr-surface)" strokeWidth={1} /> : null}
                {lookupSeg ? <Bar yAxisId="money" dataKey="__lookup" name="Lookup cost" stackId="p" fill="var(--ddr-neutral)" stroke="var(--ddr-surface)" strokeWidth={1} /> : null}
              </>
            ) : (
              <Bar yAxisId="money" dataKey="profit" name="Profit" radius={[4, 4, 4, 4]} fill="var(--ddr-profit)">
                {points.map((p) => (
                  <Cell
                    key={p.day as string}
                    fill={(p.profit as number) < 0 ? "var(--ddr-loss)" : "var(--ddr-profit)"}
                    fillOpacity={p.maturing ? 0.45 : 1}
                  />
                ))}
              </Bar>
            )}
            <Line
              yAxisId="metric"
              dataKey="metric"
              name={`${m.label} (right axis)`}
              stroke="var(--ddr-line)"
              strokeWidth={2}
              dot={{ r: 3, fill: "var(--ddr-line)" }}
              activeDot={{ r: 5 }}
              connectNulls={false}
              type="linear"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-muted-foreground">
        Bars: profit per ET day (left axis){stacked ? ", stacked by group" : "; red = loss"}. Line: {m.label} (right axis)
        {metric === "roi" ? ", blank where send cost is under $1" : ""}.
        {markerDays.length ? " Dashed ⚑ = a settings change that day." : ""}
        {data.basis === "cohort" ? " Faded bars = cohorts still maturing." : ""}
      </p>
    </div>
  );
}

interface LegendItem {
  label: string;
  color: string;
  kind: "box" | "line";
}

function ChartLegend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 pt-2 text-xs text-muted-foreground">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          <svg width="14" height="10" aria-hidden>
            {it.kind === "box" ? (
              <rect x="1" y="1" width="12" height="8" rx="2" fill={it.color} />
            ) : (
              <>
                <line x1="0" y1="5" x2="14" y2="5" stroke={it.color} strokeWidth="2" />
                <circle cx="7" cy="5" r="2.5" fill={it.color} />
              </>
            )}
          </svg>
          {it.label}
        </li>
      ))}
    </ul>
  );
}

function ChartTooltip({
  active, payload, metric, stacked, groups, folded, lookup,
}: {
  active?: boolean;
  payload?: { payload: Point }[];
  metric: LineMetric;
  stacked: boolean;
  groups: { key: string; label: string }[];
  folded: boolean;
  lookup: boolean;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const m = LINE_METRICS[metric];
  const v = p.metric as number | null;
  return (
    <div className="max-w-xs rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="mb-1 font-medium">
        {dayLabel(p.day as string)}
        {p.maturing ? <span className="ml-1 text-muted-foreground">· still maturing</span> : null}
      </div>
      <div className="flex justify-between gap-4"><span>Profit</span><span className="tabular-nums">{usd2(p.profit as number)}</span></div>
      {stacked
        ? [...groups.map((g) => [g.label, p[g.key]] as const), ...(folded ? [["Other", p.__other] as const] : []), ...(lookup ? [["Lookup cost", p.__lookup] as const] : [])].map(([k, val]) => (
            <div key={k} className="flex justify-between gap-4 pl-2 text-muted-foreground">
              <span className="truncate">{k}</span>
              <span className="tabular-nums">{usd2(Number(val ?? 0))}</span>
            </div>
          ))
        : null}
      <div className="flex justify-between gap-4">
        <span>{m.label}</span>
        <span className="tabular-nums">{v == null ? "—" : m.pct ? pctFmt(v) : v.toLocaleString("en-US")}</span>
      </div>
      {(p.markers as string[]).map((t) => (
        <div key={t} className="mt-1 border-t pt-1 text-amber-700 dark:text-amber-400">⚑ {t}</div>
      ))}
    </div>
  );
}
