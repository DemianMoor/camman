"use client";

import { Download, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { useApiCall, type ApiResult } from "@/lib/hooks/use-api-call";
import {
  DEFAULT_RECENT_DAYS,
  GROUP_LIFECYCLE_COLUMNS,
  columnPair,
  type GroupLifecycleRow,
} from "@/lib/reporting/group-lifecycle-types";
import type {
  GroupLifecycleRefreshResult,
  StoredGroupLifecycle,
} from "@/lib/reporting/group-lifecycle-store";
import { cn } from "@/lib/utils";

const n = (v: number) => v.toLocaleString();

// While another run holds the lease, poll the cheap stored read this often…
const POLL_MS = 4_000;
// …for at most this long. The hourly cron's per-org budget is 240 s.
const WAIT_CEILING_MS = 5 * 60 * 1000;

type Outcome = "recomputed" | "reused" | "waited";
type Phase = { phase: "idle" } | { phase: "running" | "waiting"; startedAt: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ago(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

/** A failed call as one sentence the operator can act on. */
function failureMessage(res: Extract<ApiResult<unknown>, { ok: false }>): string {
  // A bare platform 504 has no JSON body, so useApiCall can only say
  // "Unexpected response from server". Our own timeout carries a code.
  if (res.status === 504 && res.code !== "statement_timeout") {
    return "The server timed out before the recompute answered (HTTP 504). If it was still running, the stored numbers will update when it finishes — reload in a minute.";
  }
  return res.error;
}

// Owns its own clock, so the once-a-second tick re-renders this line and not
// the whole table.
function RefreshStatus({
  data,
  outcome,
  phase,
  loading,
  days,
}: {
  data: StoredGroupLifecycle | null;
  outcome: Outcome | null;
  phase: Phase;
  loading: boolean;
  days: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (phase.phase !== "idle") {
    const elapsed = Math.round((now - phase.startedAt) / 1000);
    return (
      <span
        className="flex items-center gap-1.5 text-xs font-medium text-foreground"
        role="status"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {phase.phase === "running"
          ? `Recomputing… ${elapsed} s`
          : `A refresh is already running — waiting for it… ${elapsed} s`}
      </span>
    );
  }
  if (loading) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {days === DEFAULT_RECENT_DAYS
          ? "Loading…"
          : `Computing the ${days}-day figure — the slow path, it is not stored…`}
      </span>
    );
  }
  if (!data) return null;
  // ⚠️ Always says WHEN. A stored figure and a just-computed one look
  // identical otherwise, and the difference is up to an hour of sends.
  if (!data.computed_at) {
    return (
      <span className="text-xs text-muted-foreground">
        not computed yet — press Refresh now
      </span>
    );
  }
  const at = new Date(data.computed_at).getTime();
  const tag =
    outcome === "recomputed"
      ? "just recomputed"
      : outcome === "reused"
        ? "a recompute had just finished, so it was reused"
        : outcome === "waited"
          ? "from the run that was already in progress"
          : data.live
            ? `computed for ${days} days, not stored`
            : null;
  return (
    <span className="text-xs text-muted-foreground" title={data.computed_at}>
      as of {formatCampaignDateTime(data.computed_at)} · {ago(at, now)}
      {tag ? ` — ${tag}` : ""}
    </span>
  );
}

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
 * The page load reads the STORED table (~126 rows, written hourly by
 * /api/cron/refresh-group-lifecycle). "Refresh now" POSTs to
 * /api/reports/group-lifecycle/refresh, which shares the cron's lease: it
 * recomputes, reuses a run that finished < 2 min ago, or — when a run is
 * already going — starts nothing and this component polls the stored read
 * until that run's computed_at lands.
 */
export function GroupLifecycleTable({
  onlyGroupId = null,
}: {
  /** Contact-group detail page: show just this group's row, no rollups. */
  onlyGroupId?: number | null;
}) {
  const [days, setDays] = useState(DEFAULT_RECENT_DAYS);
  const [data, setData] = useState<StoredGroupLifecycle | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ phase: "idle" });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Separate instances, so the button's in-flight state is not the page load's
  // (useApiCall's isLoading is per instance).
  // Destructured: the effect below depends on the stable execute, never on the
  // hook's return object (a fresh reference every render).
  const { execute: loadExecute, isLoading: loading } =
    useApiCall<StoredGroupLifecycle>();
  const post = useApiCall<GroupLifecycleRefreshResult>();
  const poll = useApiCall<StoredGroupLifecycle>();

  // The CURRENT window, read by async work that started under an older one:
  // a response for a window the operator has since changed is dropped.
  const daysRef = useRef(days);
  const alive = useRef(true);
  useEffect(() => {
    daysRef.current = days;
  }, [days]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // ⚠️ The default load READS the stored table. Changing N is NOT the stored
  // question (the store answers for N = 3), so it recomputes — slow on purpose
  // and visible as such.
  useEffect(() => {
    let stale = false;
    void (async () => {
      const res = await loadExecute(
        `/api/reports/group-lifecycle?days=${days}`,
      );
      if (stale) return;
      if (res.ok) {
        setData(res.data);
        setLoadError(null);
      } else {
        setData(null);
        setLoadError(failureMessage(res));
      }
    })();
    return () => {
      stale = true;
    };
  }, [loadExecute, days]);

  /** Poll the stored read until computed_at moves past `prev`. */
  const waitForRun = async (
    prev: string | null,
  ): Promise<
    | { kind: "done"; data: StoredGroupLifecycle }
    | { kind: "error"; message: string }
    | { kind: "timeout" }
    | { kind: "cancelled" }
  > => {
    const until = Date.now() + WAIT_CEILING_MS;
    while (Date.now() < until) {
      await sleep(POLL_MS);
      if (!alive.current || daysRef.current !== DEFAULT_RECENT_DAYS) {
        return { kind: "cancelled" };
      }
      const r = await poll.execute(
        `/api/reports/group-lifecycle?days=${DEFAULT_RECENT_DAYS}`,
      );
      if (!r.ok) return { kind: "error", message: failureMessage(r) };
      if (r.data.computed_at && r.data.computed_at !== prev) {
        return { kind: "done", data: r.data };
      }
    }
    return { kind: "timeout" };
  };

  const refresh = async () => {
    if (phase.phase !== "idle") return; // never two at once from this tab
    const forDays = days;
    const startedAt = Date.now();
    const current = () => alive.current && daysRef.current === forDays;
    const fail = (message: string) => {
      setRefreshError(message);
      toast.error(message);
    };
    setRefreshError(null);
    setPhase({ phase: "running", startedAt });
    try {
      // Only N = 3 is stored. Any other window is recomputed by the read route
      // and never written, so "refresh" there is simply reading it again.
      if (forDays !== DEFAULT_RECENT_DAYS) {
        const res = await poll.execute(
          `/api/reports/group-lifecycle?days=${forDays}`,
        );
        if (!current()) return;
        if (!res.ok) return fail(failureMessage(res));
        setData(res.data);
        setOutcome("recomputed");
        toast.success(`Recomputed the ${forDays}-day figure`);
        return;
      }

      const res = await post.execute("/api/reports/group-lifecycle/refresh", {
        method: "POST",
      });
      if (!current()) return;
      if (!res.ok) return fail(failureMessage(res));

      if (res.data.outcome === "in_progress") {
        setPhase({ phase: "waiting", startedAt });
        const w = await waitForRun(res.data.computed_at);
        if (!current() || w.kind === "cancelled") return;
        if (w.kind === "error") return fail(w.message);
        if (w.kind === "timeout") {
          return fail(
            `A refresh was already running and has not finished after ${WAIT_CEILING_MS / 60_000} minutes. The numbers shown are unchanged — reload the page later.`,
          );
        }
        setData(w.data);
        setOutcome("waited");
        toast.success("Updated from the refresh that was already running");
        return;
      }

      const { outcome: o, ...table } = res.data;
      setData(table);
      setOutcome(o);
      toast.success(
        o === "reused"
          ? "Already fresh — a recompute finished under 2 minutes ago"
          : `Recomputed in ${Math.round((Date.now() - startedAt) / 1000)} s`,
      );
    } finally {
      setPhase({ phase: "idle" });
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
              if (Number.isFinite(v) && v >= 1 && v <= 90) {
                setDays(Math.floor(v));
                setOutcome(null);
                setRefreshError(null);
              }
            }}
            className="w-28"
          />
        </div>
        <span className="pb-2 text-xs text-muted-foreground">
          Available today excludes anyone messaged inside this window.
        </span>
        <div className="ml-auto flex items-center gap-2 pb-1">
          <RefreshStatus
            data={data}
            outcome={outcome}
            phase={phase}
            loading={loading}
            days={days}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={phase.phase !== "idle" || loading}
          >
            <RefreshCw
              className={cn("mr-2 h-4 w-4", phase.phase !== "idle" && "animate-spin")}
            />
            {phase.phase === "idle" ? "Refresh now" : "Refreshing…"}
          </Button>
          <Button variant="outline" size="sm" onClick={csv} disabled={!data}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>
      </div>

      {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}
      {refreshError ? (
        <p className="text-sm text-destructive" role="alert">
          Refresh failed: {refreshError}
        </p>
      ) : null}

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
            These numbers are recomputed every hour
          </span>{" "}
          (at :13) and read from a stored table, which is why the page loads
          immediately. <em>Refresh now</em> recomputes them — unless a recompute
          finished in the last 2 minutes, which it shows instead, or one is
          already running, which it waits for. Changing the rest window also
          recomputes, because only the {DEFAULT_RECENT_DAYS}-day figure is
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
