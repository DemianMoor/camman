"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toastApiError } from "@/lib/api/toast-error";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";
import {
  STAGE_STATUS_META,
  type StageOperationalStatus,
} from "@/lib/stages/stage-status";
import { cn } from "@/lib/utils";

interface PreflightResult {
  materialized_audience: number;
  predicted_sends: number;
  excluded: {
    opt_out: number; stage_filter: number; split: number;
    content_dedup: number; lane: number; dedup_1h_predicted: number;
  };
  estimated_drain_seconds: number | null;
  blockers: string[];
  red: { no_audience: boolean; all_dedup_predicted: boolean; has_blocker: boolean };
}

interface AutopilotStage {
  stage_id: number;
  stage_number: number;
  label: string | null;
  campaign_id: number;
  campaign_name: string;
  tracking_id: string | null;
  scheduled_at: string | null;
  sent_at: string | null;
  provider_name: string | null;
  provider_paused: boolean;
  operational_status: StageOperationalStatus;
  is_lane_child: boolean;
  behavioral_tier: number | null;
  parent_complete: boolean | null;
  slip_count: number;
  slip_original_scheduled_at: string | null;
  slip_hold_at: string | null;
  slip_hold_reason: string | null;
  preflight_result: PreflightResult | null;
  preflight_aborted_at: string | null;
}

interface AutopilotResponse {
  data: AutopilotStage[];
  counts: Record<string, number>;
}

export default function AutopilotPage() {
  const [data, setData] = useState<AutopilotStage[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [tick, setTick] = useState(0);
  const fleetApi = useApiCall<AutopilotResponse>();
  const { execute } = useApiCall();
  const loading = fleetApi.isLoading;
  const fleetExec = fleetApi.execute;

  useEffect(() => {
    let alive = true;
    void fleetExec("/api/sends/autopilot").then((r) => {
      if (!alive || !r.ok) return;
      setData(r.data.data ?? []);
      setCounts(r.data.counts ?? {});
    });
    return () => {
      alive = false;
    };
  }, [fleetExec, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const act = useCallback(
    async (url: string, body: unknown, ok: string) => {
      const res = await execute(url, { method: "POST", body: JSON.stringify(body) });
      if (res.ok) {
        toast.success(ok);
        refresh();
      } else {
        toastApiError(res);
      }
    },
    [execute, refresh],
  );

  const redCount = data.filter(
    (s) => s.preflight_result && (s.preflight_result.red.no_audience || s.preflight_result.red.all_dedup_predicted || s.preflight_result.red.has_blocker),
  ).length;

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Autopilot</h1>
          <p className="text-sm text-muted-foreground">
            Scheduled stages for the week ahead — resolved-audience preflight, slip state, and the parent-complete gate.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
        </Button>
      </div>

      {/* Health summary */}
      <div className="flex flex-wrap gap-2">
        {(Object.entries(counts) as [StageOperationalStatus, number][]).map(([k, n]) => {
          const meta = STAGE_STATUS_META[k];
          if (!meta) return null;
          return (
            <span key={k} className={cn("rounded-md border px-2 py-1 text-xs font-medium", meta.badgeClass)}>
              {n} {meta.label}
            </span>
          );
        })}
        {redCount > 0 ? (
          <span className="rounded-md border border-red-300 bg-red-100 px-2 py-1 text-xs font-medium text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            ⚠️ {redCount} preflight red
          </span>
        ) : null}
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No scheduled stages in the week-ahead window.</p>
      ) : (
        <div className="space-y-2">
          {data.map((s) => (
            <StageRow key={s.stage_id} s={s} act={act} />
          ))}
        </div>
      )}
    </div>
  );
}

function StageRow({
  s,
  act,
}: {
  s: AutopilotStage;
  act: (url: string, body: unknown, ok: string) => Promise<void>;
}) {
  const meta = STAGE_STATUS_META[s.operational_status];
  const pf = s.preflight_result;
  const base = `/api/campaigns/${s.campaign_id}/stages/${s.stage_id}`;
  const [redate, setRedate] = useState("");

  const pfRed = pf && (pf.red.no_audience || pf.red.all_dedup_predicted || pf.red.has_blocker);

  return (
    <Card className={cn("border-l-4", meta?.rowClass)}>
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3 text-sm">
        <span className={cn("rounded-md border px-2 py-0.5 text-xs font-medium", meta?.badgeClass)}>
          {meta?.label}
        </span>

        <div className="min-w-[220px] flex-1">
          <Link href={`/campaigns/${s.campaign_id}`} className="font-medium hover:underline">
            {s.campaign_name}
          </Link>
          <span className="text-muted-foreground">
            {" · "}stage {s.stage_number}
            {s.label ? ` "${s.label}"` : ""}
            {s.is_lane_child ? ` · lane ${s.behavioral_tier}` : ""}
          </span>
        </div>

        {/* Schedule + slip */}
        <div className="text-xs text-muted-foreground">
          {s.scheduled_at ? formatCampaignDateTime(s.scheduled_at) : "—"}
          {s.slip_count > 0 && s.slip_original_scheduled_at ? (
            <span className="text-amber-600">
              {" "}· slipped ×{s.slip_count} (was {formatCampaignDateTime(s.slip_original_scheduled_at)})
            </span>
          ) : null}
        </div>

        {/* Parent gate (lane children) */}
        {s.is_lane_child ? (
          <span className="text-xs">
            {s.parent_complete ? "parent ✓" : <span className="text-amber-600">parent ⏳</span>}
          </span>
        ) : null}

        {/* Preflight summary */}
        {pf ? (
          <div className={cn("text-xs tabular-nums", pfRed ? "text-red-600" : "text-muted-foreground")}>
            {pf.red.has_blocker
              ? `blocked: ${pf.blockers.join(", ")}`
              : pf.red.no_audience
                ? "0 recipients"
                : `${pf.predicted_sends.toLocaleString()} will send`}
            {pf.excluded.dedup_1h_predicted > 0 ? ` · ${pf.excluded.dedup_1h_predicted.toLocaleString()} dedup` : ""}
            {pf.excluded.opt_out > 0 ? ` · ${pf.excluded.opt_out.toLocaleString()} opt-out` : ""}
            {pf.excluded.lane > 0 ? ` · ${pf.excluded.lane.toLocaleString()} lane` : ""}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">preflight pending</span>
        )}

        {/* Actions */}
        <div className="ml-auto flex items-center gap-1.5">
          {s.operational_status === "held" ? (
            <>
              <input
                type="datetime-local"
                value={redate}
                onChange={(e) => setRedate(e.target.value)}
                className="rounded border bg-background px-1.5 py-0.5 text-xs"
                aria-label="Re-date"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  act(
                    `${base}/release-hold`,
                    redate ? { scheduled_at: new Date(redate).toISOString() } : {},
                    redate ? "Hold released and re-dated" : "Hold released",
                  )
                }
              >
                {redate ? "Re-date & release" : "Release"}
              </Button>
            </>
          ) : null}

          {s.preflight_aborted_at ? (
            <Button size="sm" variant="outline" onClick={() => act(`${base}/preflight-abort`, { aborted: false }, "Re-armed")}>
              Clear abort
            </Button>
          ) : s.sent_at == null &&
            (s.operational_status === "scheduled_unprepared" || s.operational_status === "prepared") ? (
            <Button
              size="sm"
              variant="outline"
              className="text-red-600"
              onClick={() => act(`${base}/preflight-abort`, { aborted: true }, "Fire aborted")}
            >
              Abort
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
