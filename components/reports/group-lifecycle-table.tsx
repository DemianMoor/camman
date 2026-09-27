"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApiCall } from "@/lib/hooks/use-api-call";
import {
  GROUP_LIFECYCLE_STATUSES,
  type GroupLifecycleReport,
  type GroupLifecycleRollups,
  type GroupLifecycleRow,
  type GroupLifecycleStatus,
} from "@/lib/reporting/group-lifecycle-types";
import { cn } from "@/lib/utils";

const LABEL: Record<GroupLifecycleStatus, string> = {
  new: "New",
  cold: "Cold",
  hot: "Hot",
  warm: "Warm",
  freeze: "Freeze",
  suppressed: "Suppressed",
};

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
      {GROUP_LIFECYCLE_STATUSES.map((s) => (
        <td key={s} className="px-3 py-2 text-right">
          <span className="font-medium">{n(r.by_status[s].available)}</span>
          <span className="text-muted-foreground">
            {" / "}
            {n(r.by_status[s].sendable)}
          </span>
        </td>
      ))}
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
  const [table, setTable] = useState<GroupLifecycleReport | null>(null);
  const [rollups, setRollups] = useState<GroupLifecycleRollups | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tableApi = useApiCall<GroupLifecycleReport>();
  const rollupApi = useApiCall<GroupLifecycleRollups>();

  useEffect(() => {
    void (async () => {
      const res = await tableApi.execute(
        `/api/reports/group-lifecycle?part=table&days=${days}`,
      );
      if (res.ok) {
        setTable(res.data);
        setError(null);
      } else {
        setTable(null);
        setError(res.error);
      }
    })();
  }, [tableApi.execute, days]);

  useEffect(() => {
    if (onlyGroupId != null) return;
    void (async () => {
      const res = await rollupApi.execute(
        `/api/reports/group-lifecycle?part=rollups&days=${days}`,
      );
      if (res.ok) setRollups(res.data);
    })();
  }, [rollupApi.execute, days, onlyGroupId]);

  // ⚠️ Rendered only when the rollups were computed for the CURRENT N. They are
  // a separate, slower request, so after N changes the old ones are still in
  // state for a few seconds — showing them beside a grid computed with the new
  // N would put two different questions' answers in one table. Comparing
  // recent_days is how that is avoided WITHOUT clearing state inside an effect.
  const liveRollups =
    rollups && rollups.recent_days === days ? rollups : null;

  const groups = (table?.groups ?? []).filter((g) =>
    onlyGroupId == null ? true : g.group_id === onlyGroupId,
  );

  const csv = () => {
    const head = [
      "row",
      "kind",
      "code",
      ...GROUP_LIFECYCLE_STATUSES.flatMap((s) => [
        `${LABEL[s]} available`,
        `${LABEL[s]} sendable`,
      ]),
      "Total available",
      "Total sendable",
    ];
    const line = (r: GroupLifecycleRow) => [
      r.label,
      r.kind,
      r.code ?? "",
      ...GROUP_LIFECYCLE_STATUSES.flatMap((s) => [
        String(r.by_status[s].available),
        String(r.by_status[s].sendable),
      ]),
      String(r.total.available),
      String(r.total.sendable),
    ];
    const rows: string[][] = [
      head,
      ...(liveRollups?.clusters ?? []).map(line),
      ...groups.map(line),
      ...(liveRollups ? [line(liveRollups.distinct_total)] : []),
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
        <div className="ml-auto pb-1">
          <Button variant="outline" size="sm" onClick={csv} disabled={!table}>
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
                {GROUP_LIFECYCLE_STATUSES.map((s) => (
                  <th key={s} className="px-3 py-2 text-right font-medium">
                    {LABEL[s]}
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {onlyGroupId == null && liveRollups
                ? liveRollups.clusters.map((c) => <Row key={c.key} r={c} />)
                : null}
              {groups.map((g) => (
                <Row
                  key={g.key}
                  r={g}
                  indent={onlyGroupId == null && liveRollups != null}
                />
              ))}
              {onlyGroupId == null && liveRollups ? (
                <Row r={liveRollups.distinct_total} />
              ) : null}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {tableApi.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
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
          <span className="font-medium">This is a sizing estimate.</span> The
          freeze and last-message facts come from a rollup the engagement job
          refreshes every 15 minutes, while the send re-checks freeze against
          live sends — so a send can drop contacts counted here.
        </p>
        {onlyGroupId == null && !liveRollups && !error ? (
          <p>Cluster rollups and the distinct total are still loading…</p>
        ) : null}
      </div>
    </div>
  );
}
