"use client";

import { Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";
import {
  GROUP_LIFECYCLE_COLUMNS,
  columnPair,
  type GroupLifecycleRow,
} from "@/lib/reporting/group-lifecycle-types";
import type { StoredGroupLifecycle } from "@/lib/reporting/group-lifecycle-store";
import { cn } from "@/lib/utils";

const n = (v: number) => v.toLocaleString();

// Hoisted to module scope: a component declared inside the render body is a
// new type on every render, so React unmounts and remounts the whole table.
function Row({ r, indent }: { r: GroupLifecycleRow; indent?: boolean }) {
  return (
    <tr
      className={cn(
        "border-b last:border-0",
        r.kind === "cluster" && "font-medium",
        r.key === "__all__" && "border-t-2",
      )}
    >
      <td className={cn("px-3 py-2 text-left", indent && "pl-7")}>
        {r.label}
        {r.kind === "group" && r.clustered ? (
          <span className="ml-2 text-xs text-muted-foreground">in a cluster</span>
        ) : null}
      </td>
      {GROUP_LIFECYCLE_COLUMNS.map((col) => {
        const p = columnPair(r.by_status, col);
        return (
          <td key={col.key} className="px-3 py-2 text-right">
            <span className="font-medium">{n(p.available)}</span>
            <span className="text-muted-foreground">
              {" / "}
              {n(p.sendable)}
            </span>
          </td>
        );
      })}
      <td className="px-3 py-2 text-right">
        <span className="font-medium">{n(r.total.available)}</span>
        <span className="text-muted-foreground">
          {" / "}
          {n(r.total.sendable)}
        </span>
      </td>
    </tr>
    );
}

/**
 * Contact group × lifecycle, for sizing a daily campaign.
 *
 * ⚠️ TWO REQUESTS, DELIBERATELY. The per-group grid is inside the 2s bar
 * (median 1,812ms on production); the cluster unions and the distinct footer
 * need DISTINCT contacts across ~1.1M membership rows and cost ~6.3s. Loading
 * them together would put the whole screen behind the slower half, so the grid
 * renders first and the rollups fill in beneath it.
 */
export function GroupLifecycleTable({
  onlyGroupId = null,
}: {
  /** Contact-group detail page: show just this group's row, no rollups. */
  onlyGroupId?: number | null;
}) {
  const [days, setDays] = useState(3);
  const [data, setData] = useState<StoredGroupLifecycle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const api = useApiCall<StoredGroupLifecycle>();

  // ⚠️ ONE REQUEST NOW, and it reads a STORED table. The page used to issue two
  // that computed everything, and waited 15-36s for them. The engagement job
  // writes the table every 15 minutes; this reads ~126 rows.
  //
  // Changing N is NOT the stored question (the store answers for N = 3), so it
  // recomputes — which is slow on purpose and visible as such.
  useEffect(() => {
    void (async () => {
      const res = await api.execute(
        `/api/reports/group-lifecycle?days=${days}`,
      );
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else {
        setData(null);
        setError(res.error);
      }
    })();
  }, [api.execute, days]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await api.execute(
        `/api/reports/group-lifecycle?days=${days}&refresh=1`,
      );
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else {
        setError(res.error);
      }
    } finally {
      setRefreshing(false);
    }
  };

  const groups = (data?.groups ?? []).filter((g) =>
    onlyGroupId == null ? true : g.group_id === onlyGroupId,
  );
  // Clusters and the distinct total arrive in the SAME payload now, so there is
  // no second request that can fall out of step with the grid — which is what
  // the previous version had to guard against by comparing recent_days.
  const showRollups = onlyGroupId == null && data != null;

  const csv = () => {
    const head = [
      "row",
      "kind",
      "code",
      ...GROUP_LIFECYCLE_COLUMNS.flatMap((col) => [
        `${col.label} available`,
        `${col.label} sendable`,
      ]),
      "Total available",
      "Total sendable",
    ];
    const line = (r: GroupLifecycleRow) => [
      r.label,
      r.kind,
      r.code ?? "",
      ...GROUP_LIFECYCLE_COLUMNS.flatMap((col) => {
        const p = columnPair(r.by_status, col);
        return [String(p.available), String(p.sendable)];
      }),
      String(r.total.available),
      String(r.total.sendable),
    ];
    const rows: string[][] = [
      head,
      ...(showRollups && data ? data.clusters : []).map(line),
      ...groups.map(line),
      ...(showRollups && data ? [line(data.distinct_total)] : []),
    ];
    const body = rows
      .map((r) =>
        r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","),
      )
      .join("\n");
    const url = URL.createObjectURL(
      new Blob([body], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `group-lifecycle-${days}d-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="gl-days">Rested at least (days)</Label>
          <Input
            id="gl-days"
            type="number"
            min={1}
            max={90}
            value={days}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 1 && v <= 90) setDays(Math.floor(v));
            }}
            className="w-28"
          />
        </div>
        <span className="pb-2 text-xs text-muted-foreground">
          Available today excludes anyone messaged inside this window.
        </span>
        <div className="ml-auto flex items-center gap-2 pb-1">
          {/* ⚠️ Says WHICH number is on screen. A stored figure and a
              just-computed one look identical otherwise, and the difference is
              up to 15 minutes of sends. */}
          {data ? (
            <span className="text-xs text-muted-foreground">
              {data.live
                ? "computed just now"
                : data.computed_at
                  ? `as of ${formatCampaignDateTime(data.computed_at)}`
                  : "not computed yet — press Refresh now"}
            </span>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={refreshing || api.isLoading}
          >
            <RefreshCw
              className={cn("mr-2 h-4 w-4", refreshing && "animate-spin")}
            />
            Refresh now
          </Button>
          <Button variant="outline" size="sm" onClick={csv} disabled={!data}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs uppercase text-muted-foreground">
                <th className="px-3 py-2 text-left font-medium">
                  {onlyGroupId == null ? "Group" : "This group"}
                </th>
                {GROUP_LIFECYCLE_COLUMNS.map((col) => (
                  <th key={col.key} className="px-3 py-2 text-right font-medium">
                    {col.label}
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {showRollups && data
                ? data.clusters.map((c) => <Row key={c.key} r={c} />)
                : null}
              {groups.map((g) => (
                <Row
                  key={g.key}
                  r={g}
                  indent={showRollups}
                />
              ))}
              {showRollups && data ? (
                <Row r={data.distinct_total} />
              ) : null}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {api.isLoading ? (
        <p className="text-xs text-muted-foreground">
          {days === 3 && !refreshing
            ? "Loading…"
            : "Recomputing — this is the slow path, a few seconds…"}
        </p>
      ) : null}

      <div className="grid gap-1 text-xs text-muted-foreground">
        <p>
          Each cell is{" "}
          <span className="font-medium text-foreground">available today</span> /
          sendable. <span className="font-medium">Sendable</span> = active,
          eligible, not opted out.{" "}
          <span className="font-medium">Available today</span> = sendable minus
          contacts already in an active campaign, minus Freeze contacts still
          inside their own cadence, minus anyone messaged in the last {days}{" "}
          day{days === 1 ? "" : "s"}.
        </p>
        {onlyGroupId == null ? (
          <>
            <p>
              <span className="font-medium">
                A contact in several groups is counted in each row
              </span>
              , so the group rows do not sum to the distinct total — they
              overcount by however much the groups overlap.
            </p>
            <p>
              <span className="font-medium">Cluster rows are DISTINCT</span>{" "}
              across their groups, not the sum of them: someone in both Weight
              Loss and Weight Loss Y is one person to send to.
            </p>
          </>
        ) : null}
        <p>
          <span className="font-medium">
            These numbers are computed every 15 minutes
          </span>{" "}
          by the engagement job and read from a stored table, which is why the
          page loads immediately. <em>Refresh now</em> recomputes them; changing
          the rest window also recomputes, because only the {3}-day figure is
          stored.
        </p>
        <p>
          <span className="font-medium">This is a sizing estimate.</span> The
          freeze and last-message facts come from a rollup the engagement job
          refreshes every 15 minutes, while the send re-checks freeze against
          live sends — so a send can drop contacts counted here.
        </p>

      </div>
    </div>
  );
}
