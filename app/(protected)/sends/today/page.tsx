"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Ban, Play, RefreshCw, Send } from "lucide-react";
import { toast } from "sonner";

import {
  StagePrepareDialog,
  type PrepareTarget,
} from "@/components/campaigns/stage-prepare-dialog";
import { StageStatusLegend } from "@/components/campaigns/stage-status-legend";
import { useAuth } from "@/components/protected/auth-context";
import {
  CampaignResumeDialog,
  type ResumeTarget,
} from "@/components/sends/campaign-resume-dialog";
import { SendWindowIndicator } from "@/components/sends/send-window-indicator";
import { VolumeCapsMeter } from "@/components/sends/volume-caps-meter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toastApiError } from "@/lib/api/toast-error";
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
  campaign_paused: boolean;
  campaign_paused_reason: string | null;
  campaign_paused_at: string | null;
  operational_status: StageOperationalStatus;
  counts: {
    total: number;
    pending: number;
    sending: number;
    sent: number;
    failed: number;
    skippedDuplicate: number;
    skippedOptedOut: number;
  };
  window_opens_at: string | null;
  window_closes_at: string | null;
};

type PausedCampaign = {
  campaign_id: number;
  campaign_name: string;
  reason: string | null;
  paused_at: string | null;
  held_stages: number;
  held_messages: number;
};

type FleetResponse = {
  data: FleetStage[];
  counts: Partial<Record<StageOperationalStatus, number>>;
  paused_campaigns: PausedCampaign[];
};

type SendState = {
  sends_paused: boolean;
  today: { sent_today: number; cap_24h: number | null };
  stuck_count: number;
};

export default function FleetTodayPage() {
  const { can } = useAuth();
  const fleetApi = useApiCall<FleetResponse>();
  const stateApi = useApiCall<SendState>();
  const pauseApi = useApiCall<{ ok: boolean; sends_paused: boolean }>();
  const { execute: fleetExec } = fleetApi;
  const { execute: stateExec } = stateApi;

  const [fleet, setFleet] = useState<FleetResponse | null>(null);
  const [sendState, setSendState] = useState<SendState | null>(null);
  const [tick, setTick] = useState(0);
  const [prepareTarget, setPrepareTarget] = useState<PrepareTarget | null>(null);
  const [resumeTarget, setResumeTarget] = useState<ResumeTarget | null>(null);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // Emergency hard-stop toggle (org_settings.sends_paused). Engaging it halts any
  // in-flight drain at the next batch and refuses new sends until cleared.
  const canDrain = can("campaigns.drain");
  const sendsPaused = sendState?.sends_paused === true;
  async function setPaused(next: boolean) {
    const r = await pauseApi.execute("/api/sends/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: next }),
    });
    if (r.ok) {
      setSendState((s) => (s ? { ...s, sends_paused: next } : s));
      toast.success(
        next
          ? "Sending paused — no further messages will be submitted via API"
          : "Sending resumed",
      );
      refresh();
    } else {
      toastApiError(r, "Couldn't change the send state");
    }
  }

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
  const canPause = can("campaigns.pause");
  const loading = fleet === null;

  // P7/P8 — campaigns whose own send circuit is latched. Distinct from the
  // org-wide hard stop above and from a paused PROVIDER: only these campaigns
  // are frozen, and only a human can clear them.
  const pausedCampaigns = fleet?.paused_campaigns ?? [];
  const heldMessages = pausedCampaigns.reduce((n, c) => n + c.held_messages, 0);

  // Total messages materialized ("prepared") across every stage in play today.
  // Accumulates as each stage is prepared; sent ⊆ prepared, so this pairs with
  // the "Sent today" meter below it.
  const preparedToday =
    fleet?.data.reduce((sum, s) => sum + s.counts.total, 0) ?? 0;

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
          {/* Emergency hard-stop. Shown only when state has loaded so the label
              reflects the real paused/live state. While paused the primary
              "Proceed" control lives in the banner below; here we keep the
              button as a secondary affordance. */}
          {canDrain && sendState && !sendsPaused ? (
            <Button
              variant="destructive"
              size="sm"
              disabled={pauseApi.isLoading}
              onClick={() => void setPaused(true)}
            >
              <Ban className="size-3.5" aria-hidden /> Hard stop
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="size-3.5" aria-hidden /> Refresh
          </Button>
        </div>
      </div>

      {/* Emergency hard-stop banner — sending is paused org-wide. */}
      {sendsPaused ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          <Ban className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">
            <span className="font-medium">Sending is paused.</span> No further
            messages are being submitted via the provider API. Any in-flight send
            stops at its next batch. Click Proceed to resume.
          </span>
          {canDrain ? (
            <Button
              variant="default"
              size="sm"
              className="bg-green-600 hover:bg-green-700"
              disabled={pauseApi.isLoading}
              onClick={() => void setPaused(false)}
            >
              <Play className="size-3.5" aria-hidden /> Proceed (resume sending)
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Per-campaign send-circuit banner (P7/P8). The pause is otherwise
          invisible here: a latched campaign's stages render as ordinary cards,
          and because the scheduler's pause gate sits upstream of the code that
          stamps schedule_missed_at, they never go Red either. */}
      {pausedCampaigns.length > 0 ? (
        <div className="space-y-2 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-100">
          <div className="flex items-center gap-2">
            <Ban className="size-4 shrink-0" aria-hidden />
            <span>
              <span className="font-medium">
                {pausedCampaigns.length} campaign
                {pausedCampaigns.length === 1 ? "" : "s"} send-paused
              </span>{" "}
              — {heldMessages.toLocaleString()} message
              {heldMessages === 1 ? "" : "s"} held. These stay frozen until someone
              resumes them.
            </span>
          </div>
          {pausedCampaigns.map((c) => (
            <div
              key={c.campaign_id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-rose-200 bg-background/60 p-2 dark:border-rose-900"
            >
              <Link
                href={`/campaigns/${c.campaign_id}`}
                className="text-sm font-medium hover:underline"
              >
                {c.campaign_name}
              </Link>
              <span className="text-xs tabular-nums">
                {c.held_messages.toLocaleString()} held across {c.held_stages} stage
                {c.held_stages === 1 ? "" : "s"}
              </span>
              {c.reason ? (
                <span className="font-mono text-[11px] opacity-80">{c.reason}</span>
              ) : null}
              {c.paused_at ? (
                <span className="text-[11px] opacity-70">
                  since {formatCampaignDateTime(c.paused_at)}
                </span>
              ) : null}
              {canPause ? (
                <Button
                  size="sm"
                  className="ml-auto h-7 bg-green-600 hover:bg-green-700"
                  onClick={() =>
                    setResumeTarget({
                      campaign_id: c.campaign_id,
                      campaign_name: c.campaign_name,
                      reason: c.reason,
                      paused_at: c.paused_at,
                    })
                  }
                >
                  <Play className="size-3" aria-hidden /> Resume
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

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
          <CardContent className="space-y-4 pt-6">
            <div className="space-y-1">
              <div className="flex items-baseline justify-between text-xs">
                <span className="font-medium text-muted-foreground">
                  Prepared for today
                </span>
                <span className="font-mono tabular-nums">
                  {preparedToday.toLocaleString()}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Messages prepared across today&apos;s stages.
              </p>
            </div>
            {sendState ? (
              <VolumeCapsMeter
                sent={sendState.today.sent_today}
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
                    {s.campaign_paused ? (
                      <span
                        className="inline-flex items-center gap-1 rounded border border-rose-300 bg-rose-100 px-1.5 py-0.5 text-[11px] font-medium text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
                        title={s.campaign_paused_reason ?? "Campaign send paused"}
                      >
                        <Ban className="size-3" aria-hidden /> campaign paused
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
                        <span>
                          {" "}
                          · {s.counts.pending.toLocaleString()} pending
                          {s.campaign_paused ? (
                            <span className="text-rose-600">
                              {" "}
                              · held by campaign pause
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                      {s.counts.skippedOptedOut > 0 ? (
                        <span className="text-amber-600">
                          {" "}
                          · {s.counts.skippedOptedOut} STOP-cancel
                        </span>
                      ) : null}
                      {s.counts.skippedDuplicate > 0 ? (
                        <span> · {s.counts.skippedDuplicate} skipped (1h)</span>
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

      <CampaignResumeDialog
        target={resumeTarget}
        onClose={() => setResumeTarget(null)}
        onResumed={refresh}
      />
    </div>
  );
}
