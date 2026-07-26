"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Play } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import { Label } from "@/components/ui/label";
import { toastApiError } from "@/lib/api/toast-error";
import {
  campaignLocalInputToUtcIso,
  formatCampaignDateTime,
  utcToCampaignLocalInput,
} from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";

// Resume a campaign whose send circuit is latched (the P7 opt-out-rate breaker,
// or a manual pause) — and, in the SAME request, re-date the stages that can no
// longer fire on their own.
//
// Why the re-date lives here: the auto-send window is anchored to the stage's
// scheduled_at ET DAY, so a campaign resumed after that day's window closed would
// have its stages stamped `schedule_missed_at` on the very next cron tick instead
// of sending (incident brief §6.3). The server classifies each unfired stage, so
// this dialog only asks for a new time where one is actually needed, and posts
// resume + re-dates as one atomic call — never N client-side PATCHes that can
// half-apply.

export interface ResumeTarget {
  campaign_id: number;
  campaign_name: string;
  reason: string | null;
  paused_at: string | null;
}

type StageDecision = "unscheduled" | "future" | "fire" | "hold" | "missed";

interface HeldStage {
  stage_id: number;
  stage_number: number | null;
  label: string | null;
  scheduled_at: string | null;
  schedule_missed_at: string | null;
  pending: number;
  decision: StageDecision;
  suggested_scheduled_at: string | null;
}

interface CircuitResponse {
  campaign: { id: number; name: string | null; send_paused: boolean };
  stages: HeldStage[];
}

const DECISION_COPY: Record<StageDecision, { text: string; needsTime: boolean }> = {
  fire: { text: "Will fire on the next tick — no action needed.", needsTime: false },
  hold: { text: "Waits for today's send window to open, then fires.", needsTime: false },
  future: { text: "Scheduled for later — no action needed.", needsTime: false },
  unscheduled: { text: "No send time set — schedule it from the stage.", needsTime: false },
  missed: { text: "Its send window has closed — pick a new time or it will be marked missed.", needsTime: true },
};

export function CampaignResumeDialog({
  target,
  onClose,
  onResumed,
}: {
  target: ResumeTarget | null;
  onClose: () => void;
  onResumed?: () => void;
}) {
  const loadApi = useApiCall<CircuitResponse>();
  const resumeApi = useApiCall<{ ok: boolean; changed: boolean; redated: number }>();
  const { execute: loadExec } = loadApi;

  // Both pieces of state are STAMPED with the campaign they belong to and read
  // back through that stamp, so switching campaigns resets them during render —
  // no setState in the effect body (which would cascade renders).
  const [loaded, setLoaded] = useState<{ campaignId: number; stages: HeldStage[] } | null>(null);
  // stage_id -> datetime-local value (ET wall clock, per CLAUDE.md §6).
  const [timeState, setTimeState] =
    useState<{ campaignId: number; values: Record<number, string> } | null>(null);

  const campaignId = target?.campaign_id ?? null;
  const stages = loaded !== null && loaded.campaignId === campaignId ? loaded.stages : null;
  const times = timeState !== null && timeState.campaignId === campaignId ? timeState.values : {};

  useEffect(() => {
    if (campaignId == null) return;
    let active = true;
    void (async () => {
      const r = await loadExec(`/api/campaigns/${campaignId}/send-circuit`);
      if (!active) return;
      if (!r.ok) {
        toastApiError(r, "Couldn't load this campaign's held stages");
        setLoaded({ campaignId, stages: [] });
        return;
      }
      setLoaded({ campaignId, stages: r.data.stages });
      const prefill: Record<number, string> = {};
      for (const s of r.data.stages) {
        if (DECISION_COPY[s.decision].needsTime) {
          prefill[s.stage_id] = utcToCampaignLocalInput(s.suggested_scheduled_at);
        }
      }
      setTimeState({ campaignId, values: prefill });
    })();
    return () => {
      active = false;
    };
  }, [campaignId, loadExec]);

  async function submit() {
    if (!target || !stages) return;
    const redate_stages = stages
      .filter((s) => DECISION_COPY[s.decision].needsTime && times[s.stage_id])
      .map((s) => ({
        stage_id: s.stage_id,
        scheduled_at: campaignLocalInputToUtcIso(times[s.stage_id]),
      }));

    const r = await resumeApi.execute(`/api/campaigns/${target.campaign_id}/send-circuit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume", reason: "manual resume", redate_stages }),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't resume this campaign");
      return;
    }
    toast.success(
      r.data.redated > 0
        ? `Resumed — ${r.data.redated} stage${r.data.redated === 1 ? "" : "s"} re-dated`
        : "Campaign send resumed",
    );
    onClose();
    onResumed?.();
  }

  const needsAttention = (stages ?? []).filter((s) => DECISION_COPY[s.decision].needsTime);

  return (
    <FormDialog
      open={target != null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
    >
      <DialogHeader>
        <DialogTitle>Resume “{target?.campaign_name}”</DialogTitle>
        <DialogDescription>
          {target?.reason ? (
            <>
              Paused{target.paused_at ? ` ${formatCampaignDateTime(target.paused_at)}` : ""} —{" "}
              <span className="font-mono text-xs">{target.reason}</span>
            </>
          ) : (
            "Clearing the campaign's send pause lets its stages materialize and drain again."
          )}
        </DialogDescription>
      </DialogHeader>

      {stages === null ? (
        <p className="text-sm text-muted-foreground">Loading held stages…</p>
      ) : stages.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing is waiting on this campaign — resuming just clears the pause.
        </p>
      ) : (
        <div className="space-y-2">
          {stages.map((s) => {
            const copy = DECISION_COPY[s.decision];
            return (
              <div
                key={s.stage_id}
                className={
                  "rounded-md border p-2.5 text-sm " +
                  (copy.needsTime
                    ? "border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/25"
                    : "")
                }
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {copy.needsTime ? (
                    <AlertTriangle className="size-3.5 shrink-0 text-amber-600" aria-hidden />
                  ) : (
                    <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
                  )}
                  <span className="font-medium">
                    Stage {s.stage_number ?? s.stage_id}
                    {s.label ? ` — ${s.label}` : ""}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {s.pending.toLocaleString()} pending
                  </span>
                  {s.scheduled_at ? (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="size-3" aria-hidden />
                      {formatCampaignDateTime(s.scheduled_at)}
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{copy.text}</p>
                {copy.needsTime ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Label htmlFor={`redate-${s.stage_id}`} className="text-xs">
                      New send time (ET)
                    </Label>
                    <input
                      id={`redate-${s.stage_id}`}
                      type="datetime-local"
                      value={times[s.stage_id] ?? ""}
                      onChange={(e) => {
                        if (campaignId == null) return;
                        const v = e.target.value;
                        setTimeState((t) => ({
                          campaignId,
                          values: {
                            ...(t !== null && t.campaignId === campaignId ? t.values : {}),
                            [s.stage_id]: v,
                          },
                        }));
                      }}
                      className="rounded border bg-background px-2 py-1 text-xs"
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {needsAttention.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Leave a time blank to resume without re-dating that stage — the next tick will
          then mark it missed.
        </p>
      ) : null}

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={resumeApi.isLoading}>
          Cancel
        </Button>
        <Button
          className="bg-green-600 hover:bg-green-700"
          disabled={resumeApi.isLoading || stages === null}
          onClick={() => void submit()}
        >
          <Play className="size-3.5" aria-hidden />
          {resumeApi.isLoading ? "Resuming…" : "Resume sending"}
        </Button>
      </DialogFooter>
    </FormDialog>
  );
}
