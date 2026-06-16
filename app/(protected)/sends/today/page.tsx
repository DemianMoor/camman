"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw, Send } from "lucide-react";

import {
  StagePrepareDialog,
  type PrepareTarget,
} from "@/components/campaigns/stage-prepare-dialog";
import { StageStatusLegend } from "@/components/campaigns/stage-status-legend";
import { useAuth } from "@/components/protected/auth-context";
import { SendWindowIndicator } from "@/components/sends/send-window-indicator";
import { VolumeCapsMeter } from "@/components/sends/volume-caps-meter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";
import {
  STAGE_STATUS_META,
  STAGE_STATUS_ORDER,
  type StageOperationalStatus,
} from "@/lib/stages/stage-status";
import { cn } from "@/lib/utils";

type FleetStage = {
  stage_id: number;
  stage_number: number;
  label: string | null;
  campaign_id: number;
  campaign_name: string;
  tracking_id: string | null;
  scheduled_at: string | null;
  sent_at: string | null;
  schedule_missed_at: string | null;
  provider_name: string | null;
  provider_color: string | null;
  provider_paused: boolean;
  operational_status: StageOperationalStatus;
  counts: {
    total: number;
    pending: number;
    sending: number;
    sent: number;
    failed: number;
  };
  window_opens_at: string | null;
  window_closes_at: string | null;
};

type FleetResponse = {
  data: FleetStage[];
  counts: Partial<Record<StageOperationalStatus, number>>;
};

type SendState = {
  today: { sent_24h: number; cap_24h: number | null };
  stuck_count: number;
};

export default function FleetTodayPage() {
  const { can } = useAuth();
  const fleetApi = useApiCall<FleetResponse>();
  const stateApi = useApiCall<SendState>();
  const { execute: fleetExec } = fleetApi;
  const { execute: stateExec } = stateApi;

  const [fleet, setFleet] = useState<FleetResponse | null>(null);
  const [sendState, setSendState] = useState<SendState | null>(null);
  const [tick, setTick] = useState(0);
  const [prepareTarget, setPrepareTarget] = useState<PrepareTarget | null>(null);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [f, s] = await Promise.all([
        fleetExec("/api/sends/today"),
        stateExec("/api/sends/state"),
      ]);
      if (!active) return;
      if (f.ok) setFleet(f.data);
      if (s.ok) setSendState(s.data);
    })();
    return () => {
      active = false;
    };
  }, [fleetExec, stateExec, tick]);

  const canActivate = can("campaigns.activate");
  const loading = fleet === null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Today&apos;s sends</h1>
          <p className="text-sm text-muted-foreground">
            Every tracked stage in play today (ET) across all campaigns. Orange
            and red surface to the top — those need action.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <StageStatusLegend />
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="size-3.5" aria-hidden /> Refresh
          </Button>
        </div>
      </div>

      {/* Status tiles + volume meter */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardContent className="grid grid-cols-2 gap-3 pt-6 sm:grid-cols-5">
            {STAGE_STATUS_ORDER.map((key) => {
              const meta = STAGE_STATUS_META[key];
              const n = fleet?.counts[key] ?? 0;
              return (
                <div
                  key={key}
                  className="flex flex-col items-start gap-1 rounded-md border p-2"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className={cn("size-2 rounded-full", meta.dotClass)}
                      aria-hidden
                    />
                    <span className="text-lg font-semibold tabular-nums">
                      {n}
                    </span>
                  </span>
                  <span className="text-[11px] leading-tight text-muted-foreground">
                    {meta.label}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            {sendState ? (
              <VolumeCapsMeter
                sent={sendState.today.sent_24h}
                cap={sendState.today.cap_24h}
              />
            ) : null}
          </CardContent>
        </Card>
      </div>

      {/* Stuck callout (B6) */}
      {sendState && sendState.stuck_count > 0 ? (
        <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          <span>
            <span className="font-medium">
              {sendState.stuck_count} message
              {sendState.stuck_count === 1 ? "" : "s"} stuck in “sending”
            </span>{" "}
            — a send was interrupted. These are never auto-retried; open the
            stage to review.
          </span>
        </div>
      ) : null}

      {/* Stage list */}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : fleet.data.length === 0 ? (
        <div className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
          No tracked stages scheduled, sent, or missed today.
        </div>
      ) : (
        <div className="space-y-2">
          {fleet.data.map((s) => {
            const meta = STAGE_STATUS_META[s.operational_status];
            return (
              <div
                key={s.stage_id}
                className={cn(
                  "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-l-4 bg-background p-3",
                  meta.rowClass,
                )}
              >
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium",
                    meta.badgeClass,
                  )}
                  title={meta.meaning}
                >
                  <span className={cn("size-1.5 rounded-full", meta.dotClass)} />
                  {meta.label}
                </span>

                <div className="min-w-0 flex-1">
                  <Link
                    href={`/campaigns/${s.campaign_id}`}
                    className="text-sm font-medium hover:underline"
                  >
                    {s.campaign_name}
                  </Link>
                  <span className="text-muted-foreground">
                    {" "}
                    · Stage {s.stage_number}
                    {s.label ? ` — ${s.label}` : ""}
                  </span>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    {s.provider_name ? (
                      <span className="inline-flex items-center gap-1">
                        <span
                          className="size-1.5 rounded-full"
                          style={{
                            backgroundColor: s.provider_color ?? "#64748B",
                          }}
                        />
                        {s.provider_name}
                        {s.provider_paused ? (
                          <span className="text-destructive"> (paused)</span>
                        ) : null}
                      </span>
                    ) : null}
                    {s.scheduled_at ? (
                      <span>{formatCampaignDateTime(s.scheduled_at)}</span>
                    ) : null}
                    <SendWindowIndicator
                      opensAt={s.window_opens_at}
                      closesAt={s.window_closes_at}
                    />
                  </div>
                </div>

                <div className="text-right text-xs tabular-nums text-muted-foreground">
                  {s.counts.total > 0 ? (
                    <span>
                      {s.counts.sent}/{s.counts.total} sent
                      {s.counts.failed > 0 ? (
                        <span className="text-red-600">
                          {" "}
                          · {s.counts.failed} failed
                        </span>
                      ) : null}
                      {s.counts.pending > 0 ? (
                        <span> · {s.counts.pending} pending</span>
                      ) : null}
                    </span>
                  ) : (
                    <span>not prepared</span>
                  )}
                </div>

                {/* One-click Prepare on Orange rows (same shared popup). */}
                {s.operational_status === "scheduled_unprepared" &&
                canActivate ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    onClick={() =>
                      setPrepareTarget({
                        campaignId: s.campaign_id,
                        stageId: s.stage_id,
                        stageLabel: s.label,
                        scheduledAt: s.scheduled_at,
                        scheduleMissedAt: s.schedule_missed_at,
                      })
                    }
                  >
                    <Send className="size-3" aria-hidden /> Prepare
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <StagePrepareDialog
        target={prepareTarget}
        onClose={() => setPrepareTarget(null)}
        onPrepared={refresh}
      />
    </div>
  );
}
