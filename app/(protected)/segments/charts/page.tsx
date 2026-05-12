"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, GitMerge, Loader2 } from "lucide-react";
import Link from "next/link";

import { useAuth } from "@/components/protected/auth-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { cn } from "@/lib/utils";

type GroupInfo = { id: number; name: string; color: string | null };
type SegmentStats = {
  total_count: number;
};
type SegmentRow = {
  id: number;
  segment_id: string;
  name: string;
  segment_group: GroupInfo | null;
  stats: SegmentStats;
};
type SegmentsListResponse = { data: SegmentRow[] };

type OverlapEntry = { segment_ids: number[]; count: number };
type OverlapsResponse = { overlaps: OverlapEntry[] };

const MAX_SELECT = 15;

// Visual palette for selected segments. Index 0 → segments[0], etc.
const PALETTE = [
  "#2563EB", // blue
  "#DC2626", // red
  "#16A34A", // green
  "#D97706", // amber
  "#7C3AED", // purple
  "#0EA5E9", // sky
  "#DB2777", // pink
  "#65A30D", // lime
  "#0891B2", // cyan
  "#9333EA", // violet
  "#EA580C", // orange
  "#0F766E", // teal
  "#BE185D", // fuchsia
  "#4338CA", // indigo
  "#A16207", // yellow-brown
];

export default function SegmentChartsPage() {
  const { auth } = useAuth();
  const segmentsApi = useApiCall<SegmentsListResponse>();
  const overlapsApi = useApiCall<OverlapsResponse>();

  const [segments, setSegments] = useState<SegmentRow[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const [overlaps, setOverlaps] = useState<OverlapEntry[] | null>(null);
  const [selectedAtCompute, setSelectedAtCompute] = useState<number[]>([]);

  useEffect(() => {
    (async () => {
      const r = await segmentsApi.execute(
        "/api/segments/list?pageSize=100&sortBy=name&sortDir=asc",
      );
      if (r.ok) setSegments(r.data.data);
    })();
  }, [segmentsApi.execute]);

  const filteredSegments = useMemo(() => {
    if (!search.trim()) return segments;
    const q = search.trim().toLowerCase();
    return segments.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.segment_id.toLowerCase().includes(q),
    );
  }, [search, segments]);

  const toggle = useCallback(
    (id: number) => {
      setSelected((prev) => {
        if (prev.includes(id)) return prev.filter((x) => x !== id);
        if (prev.length >= MAX_SELECT) return prev;
        return [...prev, id];
      });
    },
    [],
  );

  const handleCalculate = useCallback(async () => {
    if (selected.length < 2) return;
    const result = await overlapsApi.execute("/api/segments/overlaps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segment_ids: selected }),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't compute overlaps");
      return;
    }
    setOverlaps(result.data.overlaps);
    setSelectedAtCompute([...selected]);
  }, [selected, overlapsApi]);

  if (!auth) return null;

  const selectedSegments = selectedAtCompute
    .map((id) => segments.find((s) => s.id === id))
    .filter((s): s is SegmentRow => s !== undefined);

  return (
    <div className="space-y-6">
      <Link
        href="/segments"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3" aria-hidden /> All segments
      </Link>

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          Segment Overlap Analysis
        </h1>
        <p className="text-sm text-muted-foreground">
          Pick 2–{MAX_SELECT} segments to see how their memberships intersect.
        </p>
      </header>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <Input
              placeholder="Filter segments…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 w-full max-w-sm"
            />
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>
                <span className="font-medium text-foreground">
                  {selected.length}
                </span>{" "}
                of {MAX_SELECT} selected
              </span>
              {selected.length > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelected([])}
                >
                  Clear
                </Button>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {filteredSegments.map((s) => {
              const isSelected = selected.includes(s.id);
              const idx = selected.indexOf(s.id);
              const color = isSelected ? PALETTE[idx] : null;
              const atMax = !isSelected && selected.length >= MAX_SELECT;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggle(s.id)}
                  disabled={atMax}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                    isSelected
                      ? "border-foreground bg-foreground text-background"
                      : "bg-background hover:bg-muted",
                    atMax && "cursor-not-allowed opacity-50",
                  )}
                >
                  {color ? (
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                  ) : null}
                  <span>{s.name}</span>
                  <span className="text-[10px] tabular-nums opacity-70">
                    ({s.stats.total_count.toLocaleString()})
                  </span>
                </button>
              );
            })}
            {filteredSegments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No segments match your filter.
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              onClick={handleCalculate}
              disabled={selected.length < 2 || overlapsApi.isLoading}
            >
              {overlapsApi.isLoading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <GitMerge className="size-4" aria-hidden />
              )}
              Calculate overlaps
            </Button>
          </div>
        </CardContent>
      </Card>

      {overlaps && selectedSegments.length >= 2 ? (
        <div className="space-y-6">
          {selectedSegments.length === 2 ? (
            <VennDiagram2
              segments={selectedSegments}
              overlaps={overlaps}
              colors={PALETTE}
            />
          ) : selectedSegments.length === 3 ? (
            <VennDiagram3
              segments={selectedSegments}
              overlaps={overlaps}
              colors={PALETTE}
            />
          ) : null}

          <OverlapTable
            segments={selectedSegments}
            overlaps={overlaps}
            colors={PALETTE}
          />
        </div>
      ) : null}
    </div>
  );
}

// ============ Venn 2 ============
// Two overlapping circles. Areas are NOT to scale (geometrically accurate
// Venn diagrams for N=2 require differing circle sizes by total_count which
// looks lopsided for small overlaps — the standard pattern is equal-sized
// circles with the numeric labels carrying the magnitude).
function VennDiagram2({
  segments,
  overlaps,
  colors,
}: {
  segments: SegmentRow[];
  overlaps: OverlapEntry[];
  colors: string[];
}) {
  const [a, b] = segments;
  const aOnly = findCount(overlaps, [a.id]);
  const bOnly = findCount(overlaps, [b.id]);
  const both = findCount(overlaps, [a.id, b.id]);
  const aExclusive = aOnly - both;
  const bExclusive = bOnly - both;

  const aColor = colors[0];
  const bColor = colors[1];

  return (
    <Card>
      <CardContent className="pt-6">
        <h2 className="mb-4 text-sm font-medium">Overlap visualization</h2>
        <div className="flex justify-center">
          <svg
            viewBox="0 0 400 240"
            className="w-full max-w-md"
            role="img"
            aria-label="Two-set Venn diagram"
          >
            <circle
              cx="150"
              cy="120"
              r="90"
              fill={aColor}
              fillOpacity={0.35}
              stroke={aColor}
              strokeWidth={2}
            />
            <circle
              cx="250"
              cy="120"
              r="90"
              fill={bColor}
              fillOpacity={0.35}
              stroke={bColor}
              strokeWidth={2}
            />
            <text
              x="100"
              y="125"
              textAnchor="middle"
              className="fill-foreground text-base font-semibold"
            >
              {aExclusive.toLocaleString()}
            </text>
            <text
              x="200"
              y="125"
              textAnchor="middle"
              className="fill-foreground text-base font-semibold"
            >
              {both.toLocaleString()}
            </text>
            <text
              x="300"
              y="125"
              textAnchor="middle"
              className="fill-foreground text-base font-semibold"
            >
              {bExclusive.toLocaleString()}
            </text>
            <text
              x="100"
              y="25"
              textAnchor="middle"
              className="fill-muted-foreground text-xs"
            >
              {truncate(a.name, 24)}
            </text>
            <text
              x="300"
              y="25"
              textAnchor="middle"
              className="fill-muted-foreground text-xs"
            >
              {truncate(b.name, 24)}
            </text>
          </svg>
        </div>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Numbers show contacts unique to each region.
        </p>
      </CardContent>
    </Card>
  );
}

// ============ Venn 3 ============
// Three overlapping circles. Same caveat re: area-to-scale.
// Region counts derived from inclusion-exclusion:
//   |A only| = |A| - |A∩B| - |A∩C| + |A∩B∩C|
//   |A∩B only| = |A∩B| - |A∩B∩C|
//   etc.
function VennDiagram3({
  segments,
  overlaps,
  colors,
}: {
  segments: SegmentRow[];
  overlaps: OverlapEntry[];
  colors: string[];
}) {
  const [a, b, c] = segments;
  const A = findCount(overlaps, [a.id]);
  const B = findCount(overlaps, [b.id]);
  const C = findCount(overlaps, [c.id]);
  const AB = findCount(overlaps, [a.id, b.id]);
  const AC = findCount(overlaps, [a.id, c.id]);
  const BC = findCount(overlaps, [b.id, c.id]);
  const ABC = findCount(overlaps, [a.id, b.id, c.id]);

  const onlyA = A - AB - AC + ABC;
  const onlyB = B - AB - BC + ABC;
  const onlyC = C - AC - BC + ABC;
  const onlyAB = AB - ABC;
  const onlyAC = AC - ABC;
  const onlyBC = BC - ABC;

  const aColor = colors[0];
  const bColor = colors[1];
  const cColor = colors[2];

  return (
    <Card>
      <CardContent className="pt-6">
        <h2 className="mb-4 text-sm font-medium">Overlap visualization</h2>
        <div className="flex justify-center">
          <svg
            viewBox="0 0 400 360"
            className="w-full max-w-md"
            role="img"
            aria-label="Three-set Venn diagram"
          >
            <circle
              cx="155"
              cy="150"
              r="100"
              fill={aColor}
              fillOpacity={0.3}
              stroke={aColor}
              strokeWidth={2}
            />
            <circle
              cx="245"
              cy="150"
              r="100"
              fill={bColor}
              fillOpacity={0.3}
              stroke={bColor}
              strokeWidth={2}
            />
            <circle
              cx="200"
              cy="230"
              r="100"
              fill={cColor}
              fillOpacity={0.3}
              stroke={cColor}
              strokeWidth={2}
            />
            {/* Region counts */}
            <RegionLabel x={105} y={140} value={onlyA} />
            <RegionLabel x={295} y={140} value={onlyB} />
            <RegionLabel x={200} y={290} value={onlyC} />
            <RegionLabel x={200} y={130} value={onlyAB} />
            <RegionLabel x={150} y={220} value={onlyAC} />
            <RegionLabel x={250} y={220} value={onlyBC} />
            <RegionLabel x={200} y={185} value={ABC} bold />
            {/* Segment labels */}
            <text
              x="85"
              y="55"
              textAnchor="middle"
              className="fill-muted-foreground text-xs"
            >
              {truncate(a.name, 18)}
            </text>
            <text
              x="315"
              y="55"
              textAnchor="middle"
              className="fill-muted-foreground text-xs"
            >
              {truncate(b.name, 18)}
            </text>
            <text
              x="200"
              y="345"
              textAnchor="middle"
              className="fill-muted-foreground text-xs"
            >
              {truncate(c.name, 18)}
            </text>
          </svg>
        </div>
      </CardContent>
    </Card>
  );
}

function RegionLabel({
  x,
  y,
  value,
  bold,
}: {
  x: number;
  y: number;
  value: number;
  bold?: boolean;
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor="middle"
      className={cn(
        "fill-foreground text-sm",
        bold ? "font-bold" : "font-semibold",
      )}
    >
      {value.toLocaleString()}
    </text>
  );
}

// ============ Overlap subset table ============
// For N ≥ 4 this is the primary view. For N=2/3 it's a companion table.
// Capped by the API to singletons + pairs + triples + full N-way.
function OverlapTable({
  segments,
  overlaps,
  colors,
}: {
  segments: SegmentRow[];
  overlaps: OverlapEntry[];
  colors: string[];
}) {
  const [sortBy, setSortBy] = useState<"count" | "size">("count");
  const idToColor = new Map<number, string>();
  segments.forEach((s, i) => idToColor.set(s.id, colors[i]));
  const idToName = new Map<number, string>();
  segments.forEach((s) => idToName.set(s.id, s.name));

  const largest = Math.max(...overlaps.map((o) => o.count), 0);
  const largestSingle = Math.max(
    ...overlaps.filter((o) => o.segment_ids.length === 1).map((o) => o.count),
    0,
  );

  const rows = [...overlaps].sort((a, b) => {
    if (sortBy === "count") return b.count - a.count;
    if (a.segment_ids.length !== b.segment_ids.length)
      return a.segment_ids.length - b.segment_ids.length;
    return b.count - a.count;
  });

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium">Subset breakdown</h2>
          <div className="flex items-center gap-1 text-xs">
            <span className="text-muted-foreground">Sort:</span>
            <button
              type="button"
              onClick={() => setSortBy("count")}
              className={cn(
                "rounded px-2 py-0.5",
                sortBy === "count"
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              By count
            </button>
            <button
              type="button"
              onClick={() => setSortBy("size")}
              className={cn(
                "rounded px-2 py-0.5",
                sortBy === "size"
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              By subset size
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">Subset</th>
                <th className="py-2 pr-4 font-medium">Size</th>
                <th className="py-2 pr-4 text-right font-medium">Contacts</th>
                <th className="py-2 text-right font-medium">
                  % of largest singleton
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const pct =
                  largestSingle > 0 ? (row.count / largestSingle) * 100 : 0;
                const barWidth =
                  largest > 0 ? (row.count / largest) * 100 : 0;
                return (
                  <tr
                    key={row.segment_ids.join("-")}
                    className="border-b last:border-b-0 hover:bg-muted/30"
                  >
                    <td className="py-2 pr-4">
                      <div className="flex flex-wrap gap-1">
                        {row.segment_ids.map((id) => (
                          <Badge
                            key={id}
                            variant="outline"
                            className="gap-1.5"
                          >
                            <span
                              className="size-2 rounded-full"
                              style={{
                                backgroundColor: idToColor.get(id) ?? "#64748B",
                              }}
                            />
                            {truncate(idToName.get(id) ?? `#${id}`, 28)}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {row.segment_ids.length === 1
                        ? "singleton"
                        : row.segment_ids.length === 2
                          ? "pair"
                          : row.segment_ids.length === 3
                            ? "triple"
                            : `${row.segment_ids.length}-way`}
                    </td>
                    <td className="py-2 pr-4 text-right font-mono tabular-nums">
                      <div className="relative">
                        <div className="absolute inset-y-0 right-0 rounded bg-foreground/5"
                          style={{ width: `${barWidth}%` }} />
                        <span className="relative">
                          {row.count.toLocaleString()}
                        </span>
                      </div>
                    </td>
                    <td className="py-2 text-right tabular-nums text-muted-foreground">
                      {pct.toFixed(1)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {segments.length > 3 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            For 4 or more segments a true Venn diagram becomes geometrically
            ambiguous; the table is the canonical view. The API caps the
            breakdown to singletons, pairs, triples, and the full N-way
            intersection.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function findCount(overlaps: OverlapEntry[], ids: number[]): number {
  const sorted = [...ids].sort((a, b) => a - b);
  const match = overlaps.find(
    (o) =>
      o.segment_ids.length === sorted.length &&
      o.segment_ids.every((id, i) => id === sorted[i]),
  );
  return match?.count ?? 0;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
