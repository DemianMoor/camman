"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Ban, Play, RefreshCw } from "lucide-react";
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
import {
  PhoneStageGroup,
  formatSendingNumber,
  type FleetStage,
} from "@/components/sends/phone-stage-group";
import { VolumeCapsMeter } from "@/components/sends/volume-caps-meter";
import {
  SearchableSelect,
  type SearchableSelectOption,
} from "@/components/searchable-select";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toastApiError } from "@/lib/api/toast-error";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { formatPhoneInternational } from "@/lib/phone-validation";
import { groupStagesByPhone } from "@/lib/sends/group-stages-by-phone";
import {
  STAGE_STATUS_META,
  STAGE_STATUS_ORDER,
  type StageOperationalStatus,
} from "@/lib/stages/stage-status";
import { cn } from "@/lib/utils";

type PausedCampaign = {
  campaign_id: number;
  campaign_name: string;
  reason: string | null;
  paused_at: string | null;
  held_stages: number;
  held_messages: number;
};

type PreparedByPhone = {
  phone_number: string | null;
  number_type: string | null;
  count: number;
};

type FleetResponse = {
  data: FleetStage[];
  counts: Partial<Record<StageOperationalStatus, number>>;
  paused_campaigns: PausedCampaign[];
  prepared_by_phone: PreparedByPhone[];
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
  const onPrepare = useCallback(
    (s: FleetStage) =>
      setPrepareTarget({
        campaignId: s.campaign_id,
        stageId: s.stage_id,
        stageLabel: s.label,
        scheduledAt: s.scheduled_at,
        scheduleMissedAt: s.schedule_missed_at,
      }),
    [],
  );
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

  // Stages grouped by the number that sends them. The tab bar and the "All"
  // tab both render from this one list, so a number tab and its section on All
  // are the same rows in the same order by construction.
  const phoneGroups = useMemo(
    () => groupStagesByPhone(fleet?.data ?? []),
    [fleet],
  );

  // A number in play today may not be in play tomorrow, so the selection is
  // deliberately NOT persisted — restoring a stale number onto an empty day is
  // worse than defaulting to All. Falls back to All if the selected number
  // leaves the list (e.g. after a refresh).
  const [selectedKey, setSelectedKey] = useState("all");
  const activeKey =
    selectedKey === "all" || phoneGroups.some((g) => g.key === selectedKey)
      ? selectedKey
      : "all";
  const visibleGroups =
    activeKey === "all"
      ? phoneGroups
      : phoneGroups.filter((g) => g.key === activeKey);

  // Options for the number filter. `color` paints the dot the component already
  // renders on both the trigger and the row, so the "this number needs action"
  // signal survives the move from tabs to a dropdown. `searchText` carries the
  // bare digits so typing "8446210404" finds a number displayed as
  // "+1 844 621 0404".
  const numberOptions: SearchableSelectOption[] = useMemo(() => {
    const all: SearchableSelectOption = {
      value: "all",
      label: `All numbers — ${fleet?.data.length ?? 0} stage${
        (fleet?.data.length ?? 0) === 1 ? "" : "s"
      }`,
    };
    return [
      all,
      ...phoneGroups.map((g) => ({
        value: g.key,
        label: `${formatSendingNumber(g.phone_number)}${
          g.provider_name ? ` (${g.provider_name})` : ""
        } — ${g.stages.length} stage${g.stages.length === 1 ? "" : "s"}`,
        color: g.needsAction ? "#F97316" : null,
        searchText: [g.phone_number ?? "", g.provider_name ?? ""].join(" "),
      })),
    ];
  }, [phoneGroups, fleet]);

  const numbersNeedingAction = phoneGroups.filter((g) => g.needsAction).length;

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
              {fleet && fleet.prepared_by_phone.length > 0 ? (
                <div className="pt-1">
                  <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                    By number
                  </p>
                  <div className="space-y-0.5">
                    {fleet.prepared_by_phone.map((row, i) => (
                      <div
                        key={i}
                        className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground"
                      >
                        <span className="truncate font-mono">
                          {row.phone_number
                            ? formatPhoneInternational(row.phone_number)
                            : "(no phone)"}
                          {row.number_type ? (
                            <span className="ml-1 opacity-60">
                              {row.number_type === "10dlc"
                                ? "10DLC"
                                : row.number_type === "toll_free"
                                  ? "TF"
                                  : row.number_type === "short_code"
                                    ? "SC"
                                    : row.number_type}
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 tabular-nums">
                          {row.count.toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
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

      {/* Stage list — grouped by the number that sends each stage. */}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : fleet.data.length === 0 ? (
        <div className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
          No tracked stages scheduled, sent, or missed today.
        </div>
      ) : (
        <div className="space-y-4">
          {/* Number filter. A dropdown rather than a row of tabs so the bar
              stays one line as the day's number count grows, and so a number
              can be found by typing its digits. The orange dot on an option
              (and on the trigger once picked) marks a number holding a stage
              that needs action. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b pb-3">
            <label
              className="text-sm font-medium text-muted-foreground"
              htmlFor="today-number-filter"
            >
              Number
            </label>
            <SearchableSelect
              options={numberOptions}
              value={activeKey}
              onChange={setSelectedKey}
              className="min-w-[26rem]"
              searchPlaceholder="Search by number or provider…"
              emptyMessage="No number matches"
              aria-label="Filter today's stages by sending number"
            />
            {activeKey === "all" && numbersNeedingAction > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="size-1.5 rounded-full bg-orange-500" aria-hidden />
                {numbersNeedingAction} number
                {numbersNeedingAction === 1 ? "" : "s"} need
                {numbersNeedingAction === 1 ? "s" : ""} action
              </span>
            ) : null}
            {activeKey !== "all" ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => setSelectedKey("all")}
              >
                Show all numbers
              </Button>
            ) : null}
          </div>

          <div className="space-y-6">
            {visibleGroups.map((g) => (
              <PhoneStageGroup
                key={g.key}
                group={g}
                canActivate={canActivate}
                onPrepare={onPrepare}
              />
            ))}
          </div>
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
