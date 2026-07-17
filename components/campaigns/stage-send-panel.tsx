"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Ban, CheckCircle2, CircleSlash, Download, SendHorizonal } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/components/protected/auth-context";
import { LiveSendingBanner } from "@/components/sends/live-sending-banner";
import {
  StagePrepareDialog,
  type PrepareTarget,
} from "@/components/campaigns/stage-prepare-dialog";
import { StageReadinessChecklist } from "@/components/sends/stage-readiness-checklist";
import { calculateSmsSegments } from "@/lib/creative-helpers";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";

type SendStatus = {
  send_approved: boolean;
  // Effective gate = env backstop AND the DB master switch (Settings → Sending).
  send_enabled: boolean;
  env_send_enabled: boolean;
  org_sends_enabled: boolean;
  // Scheduled-send state (see lib/quiet-hours.ts). sent_at set ⇒ fired/locked;
  // schedule_missed_at set ⇒ the ET-day window closed before it fired.
  scheduled_at: string | null;
  sent_at: string | null;
  schedule_missed_at: string | null;
  counts: { total: number; pending: number; sending: number; sent: number; failed: number };
  // The real frozen message of one materialized row (null before kickoff).
  sample_rendered_text: string | null;
  // Reconciliation (WS3 G1): pool partitions into attempted + excluded; gap>0 is our bug.
  reconciliation: {
    pool_total: number;
    qualified: number;
    attempted: number;
    excluded_optout: number;
    excluded_filter: number;
    excluded_split: number;
    excluded_dedup: number;
    excluded_total: number;
    gap: number;
    closed: boolean;
  };
  // Attempt-evidence breakdown (WS3 G3): latest-attempt classification rollup.
  attempts: {
    accepted: number;
    mine_transport: number;
    theirs_rejected: number;
    indeterminate: number;
    owners: { us: number; texthub: number; manual: number };
    groups: { classification: string; error: string | null; count: number }[];
    total_failed: number;
  };
};

const CLASSIFICATION_LABEL: Record<string, string> = {
  accepted: "accepted",
  mine_transport: "transport (ours)",
  theirs_rejected: "TextHub-rejected",
  indeterminate: "indeterminate",
};

// Operating surface for the riskiest action in the system: approve → kick off
// (materialize + mint) → drain (real SMS). Guardrails: visible gate states,
// live counts, drain disabled unless approved + globally enabled + something
// pending + manager+, and an explicit irreversible-send confirmation.
export function StageSendPanel({
  campaignId,
  stageId,
}: {
  campaignId: number;
  stageId: number;
}) {
  const { can } = useAuth();
  const statusApi = useApiCall<SendStatus>();
  const abortApi = useApiCall<{ ok: boolean; discarded: number }>();
  const drainApi = useApiCall<{
    ok: boolean;
    sent: number;
    failed: number;
    processed: number;
    halted: boolean;
    stuck: number;
    remaining: number;
  }>();
  const retryApi = useApiCall<{ ok: boolean; requeued: number; sent: number; failed: number }>();
  const { execute: statusExec } = statusApi;

  const [status, setStatus] = useState<SendStatus | null>(null);
  const [tick, setTick] = useState(0);
  const [confirmDrain, setConfirmDrain] = useState(false);
  // Prepare flow now lives in the shared StagePrepareDialog (§A2) — one popup,
  // one handler, identical to the stages-list-row entry point.
  const [prepareOpen, setPrepareOpen] = useState(false);
  const [confirmAbort, setConfirmAbort] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await statusExec(`/api/campaigns/${campaignId}/stages/${stageId}/send`);
      if (active && r.ok) setStatus(r.data);
    })();
    return () => {
      active = false;
    };
  }, [campaignId, stageId, tick, statusExec]);

  const refresh = () => setTick((n) => n + 1);

  const canActivate = can("campaigns.activate");
  const canSend = can("campaigns.drain"); // manager+ (the money-spending action)

  async function abortArmed() {
    const r = await abortApi.execute(
      `/api/campaigns/${campaignId}/stages/${stageId}/send/abort`,
      { method: "POST" },
    );
    setConfirmAbort(false);
    if (!r.ok) {
      toastApiError(r, "Couldn't cancel the prepared send");
      return;
    }
    toast.success(`Send cancelled — ${r.data.discarded.toLocaleString()} pending message${r.data.discarded === 1 ? "" : "s"} discarded. The stage is editable again.`);
    refresh();
  }

  async function drain() {
    const r = await drainApi.execute(
      `/api/campaigns/${campaignId}/stages/${stageId}/send/drain`,
      { method: "POST" },
    );
    setConfirmDrain(false);
    if (!r.ok) {
      toastApiError(r, "Send failed");
      return;
    }
    const d = r.data;
    toast.success(
      `Submitted ${d.sent} (accepted by TextHub), failed ${d.failed}${d.halted ? " (halted)" : ""}${d.stuck ? `, ${d.stuck} stuck` : ""}`,
    );
    refresh();
  }

  async function retryFailed() {
    const r = await retryApi.execute(
      `/api/campaigns/${campaignId}/stages/${stageId}/send/retry-failed`,
      { method: "POST" },
    );
    if (!r.ok) {
      toastApiError(r, "Retry failed");
      return;
    }
    toast.success(`Retried ${r.data.requeued} — sent ${r.data.sent}, failed ${r.data.failed}`);
    refresh();
  }

  if (!status) {
    return <p className="text-sm text-muted-foreground">Loading send status…</p>;
  }

  const pending = status.counts.pending;
  // Send-flow state derivation (WS2 collapsed Approve Send). Kept pure (no
  // render-time clock): a stage with a schedule that hasn't fired or been marked
  // missed is treated as scheduled/armed; the server decides arm-vs-send-now from
  // the real clock at commit time.
  const hasBatch = status.counts.total > 0; // already materialized
  const willSchedule =
    status.scheduled_at != null && status.schedule_missed_at == null;
  // Prepared = materialized for a schedule, nothing released/sent yet.
  const prepared =
    pending > 0 && willSchedule && status.sent_at == null && status.counts.sent === 0;
  // Cancelable = materialized with a pending remainder and NOTHING out yet.
  // Mirrors the server abort guard exactly (sent_at NULL, no sending/sent rows),
  // so the button only shows when the recall would actually succeed. Covers the
  // materialized send-now case the "prepared" branch doesn't (no schedule set,
  // or the schedule was missed) — its own branch renders the cancel affordance.
  const canCancel =
    hasBatch &&
    pending > 0 &&
    status.sent_at == null &&
    status.counts.sending === 0 &&
    status.counts.sent === 0;
  // Shared Prepare popup target (§A2). Built from live status so arm-vs-now copy
  // matches; the server still makes the authoritative call at commit.
  const prepareTarget: PrepareTarget | null = prepareOpen
    ? {
        campaignId,
        stageId,
        scheduledAt: status.scheduled_at,
        scheduleMissedAt: status.schedule_missed_at,
      }
    : null;
  // Name the exact gate that's blocking. The DB master switch (Settings) is the
  // day-to-day control; the env backstop is the deploy-level one.
  const sendOffReason = !status.org_sends_enabled
    ? "Live SMS sending is off — turn it on in Settings → Sending"
    : !status.env_send_enabled
      ? "Sending is blocked at the deploy level (SEND_ENABLED is off)"
      : null;
  const drainBlockedReason = !canSend
    ? "Requires manager+ to send"
    : sendOffReason
      ? sendOffReason
      : !status.send_approved
        ? "Approve the stage first"
        : pending === 0
          ? "Nothing pending to send"
          : null;

  const rec = status.reconciliation;
  const excludedBreakdown = [
    rec.excluded_optout ? `${rec.excluded_optout} opt-out` : null,
    rec.excluded_filter ? `${rec.excluded_filter} filtered` : null,
    rec.excluded_split ? `${rec.excluded_split} other split` : null,
    rec.excluded_dedup ? `${rec.excluded_dedup} already received` : null,
  ]
    .filter(Boolean)
    .join(", ");

  const ownerParts = [
    status.attempts.owners.us ? `${status.attempts.owners.us} transport (ours)` : null,
    status.attempts.owners.texthub
      ? `${status.attempts.owners.texthub} TextHub-rejected (escalate)`
      : null,
    status.attempts.owners.manual
      ? `${status.attempts.owners.manual} indeterminate (reconcile)`
      : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="space-y-4">
      {/* Global live-sending master state (Bug 2): the one switch that actually
          gates sending, made unambiguous and actionable here. */}
      <LiveSendingBanner variant="strip" />

      {/* Per-stage gate state (distinct from the global master switch above). */}
      <div className="flex flex-wrap gap-2 text-xs">
        <GateBadge on={status.send_approved} onLabel="Approved to send" offLabel="Not approved" />
      </div>

      {/* Schedule state */}
      {status.schedule_missed_at ? (
        <p className="flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="size-3.5" aria-hidden />
          Missed scheduled send — the sending window closed before it fired.
          Reschedule the stage to prepare it again, or send now.
        </p>
      ) : status.sent_at ? (
        <p className="text-xs text-muted-foreground">
          Sent {formatCampaignDateTime(status.sent_at)}.
        </p>
      ) : status.scheduled_at ? (
        <p className="text-xs text-muted-foreground">
          Scheduled for {formatCampaignDateTime(status.scheduled_at)} — fires
          automatically within the provider&apos;s sending hours once approved.
        </p>
      ) : null}

      {/* Live counts */}
      <div className="grid grid-cols-5 gap-2 text-center">
        {([
          ["Total", status.counts.total],
          ["Pending", status.counts.pending],
          ["Sending", status.counts.sending],
          ["Submitted", status.counts.sent],
          ["Failed", status.counts.failed],
        ] as const).map(([label, n]) => (
          <div key={label} className="rounded-md border p-2">
            <div className="text-lg font-semibold">{n}</div>
            <div className="text-[11px] uppercase text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>

      {status.counts.sending > 0 ? (
        <p className="flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="size-3.5" aria-hidden />
          {status.counts.sending} stuck in “sending” (a send was interrupted) — never auto-retried; review manually.
        </p>
      ) : null}

      {/* Reconciliation (WS3 G1): no silent drops. */}
      {rec.pool_total > 0 ? (
        rec.closed ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
            Pool {rec.pool_total.toLocaleString()} = {rec.attempted.toLocaleString()} attempted +{" "}
            {rec.excluded_total.toLocaleString()} excluded
            {excludedBreakdown ? ` (${excludedBreakdown})` : ""}. Closed ✓
          </p>
        ) : (
          <p className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
            {Math.abs(rec.gap).toLocaleString()} recipient
            {Math.abs(rec.gap) === 1 ? "" : "s"} unaccounted — pool{" "}
            {rec.pool_total.toLocaleString()} ≠ {rec.attempted.toLocaleString()} attempted +{" "}
            {rec.excluded_total.toLocaleString()} excluded. This is a materialization bug; don&apos;t
            rely on this send until it&apos;s resolved.
          </p>
        )
      ) : null}

      {/* Failure banner (WS3 G3): persistent mine/theirs/indeterminate split. */}
      {status.attempts.total_failed > 0 ? (
        <div className="space-y-1.5 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-medium">
            {status.attempts.total_failed.toLocaleString()} failed
            {ownerParts ? ` — ${ownerParts}` : ""}.
          </p>
          {status.attempts.groups.length > 0 ? (
            <ul className="space-y-0.5">
              {status.attempts.groups.map((g, i) => (
                <li key={i} className="font-mono">
                  {g.count.toLocaleString()}× {CLASSIFICATION_LABEL[g.classification] ?? g.classification}
                  {g.error ? `: ${g.error}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {status.attempts.owners.texthub > 0 || status.attempts.owners.manual > 0 ? (
            <a
              href={`/api/campaigns/${campaignId}/stages/${stageId}/send/escalation`}
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-400 bg-white/60 px-2 py-1 font-medium text-amber-900 hover:bg-white dark:bg-black/20 dark:text-amber-100"
            >
              <Download className="size-3.5" aria-hidden /> Export escalation packet (
              {(status.attempts.owners.texthub + status.attempts.owners.manual).toLocaleString()})
            </a>
          ) : null}
        </div>
      ) : null}

      {/* The real frozen message that will send (post-kickoff) — the truth, with
          the actual minted link, not a preview. */}
      {status.sample_rendered_text ? (
        <div className="space-y-1">
          <div className="text-xs uppercase text-muted-foreground">This is what will send</div>
          <pre className="whitespace-pre-wrap rounded-md bg-muted/40 p-3 font-mono text-xs">
            {status.sample_rendered_text}
          </pre>
          {(() => {
            const seg = calculateSmsSegments(status.sample_rendered_text);
            return (
              <div className="text-xs tabular-nums text-muted-foreground">
                {seg.characters.toLocaleString()} characters · {seg.segments} segment
                {seg.segments === 1 ? "" : "s"} ({seg.charset}) · link is unique per recipient
              </div>
            );
          })()}
        </div>
      ) : null}

      {/* Actions (§A2 — Prepare via the shared popup) */}
      {prepared ? (
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 rounded-md border border-blue-300 bg-blue-50 p-2 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
            <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
            Prepared — {pending.toLocaleString()} message{pending === 1 ? "" : "s"} will send automatically
            {status.scheduled_at ? ` at ${formatCampaignDateTime(status.scheduled_at)}` : ""} once the
            send window is open. The schedule is locked until you cancel.
          </p>
          {canActivate ? (
            <Button variant="outline" onClick={() => setConfirmAbort(true)} disabled={abortApi.isLoading}>
              <Ban className="size-4" aria-hidden /> Cancel prepared send
            </Button>
          ) : null}
        </div>
      ) : !hasBatch ? (
        <div className="space-y-2">
          {/* §B2: live readiness checklist, visible before opening the popup. */}
          <StageReadinessChecklist
            campaignId={campaignId}
            stageId={stageId}
            refreshKey={tick}
          />
          <Button
            onClick={() => setPrepareOpen(true)}
            disabled={!canActivate || (!willSchedule && !canSend)}
            title={
              !canActivate
                ? "Requires operator+ to commit a send"
                : !willSchedule && !canSend
                  ? "Sending now requires manager+. Set a Scheduled time to prepare it instead."
                  : undefined
            }
          >
            <SendHorizonal className="size-4" aria-hidden />
            {willSchedule ? "Prepare (for schedule)" : "Prepare & send now"}
          </Button>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {willSchedule ? (
              <>
                <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
                Materializes now and sends automatically at{" "}
                {status.scheduled_at ? formatCampaignDateTime(status.scheduled_at) : "the scheduled time"}.
              </>
            ) : (
              <>
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                No schedule set — this sends immediately on confirm. Set a Scheduled time on the stage
                to prepare it instead.
              </>
            )}
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => setConfirmDrain(true)}
              disabled={drainBlockedReason !== null || drainApi.isLoading}
              title={drainBlockedReason ?? undefined}
            >
              {drainApi.isLoading ? "Sending…" : `Send now${pending > 0 ? ` (${pending})` : ""}`}
            </Button>
            {canSend && status.counts.failed > 0 ? (
              <Button
                variant="outline"
                onClick={() => void retryFailed()}
                disabled={retryApi.isLoading || !status.send_enabled}
                title={sendOffReason ?? undefined}
              >
                {retryApi.isLoading ? "Retrying…" : `Retry failed (${status.counts.failed})`}
              </Button>
            ) : null}
            {canActivate && canCancel ? (
              <Button
                variant="outline"
                onClick={() => setConfirmAbort(true)}
                disabled={abortApi.isLoading}
                title="Cancel this materialized send and revert the stage to editable"
              >
                <Ban className="size-4" aria-hidden /> Cancel
              </Button>
            ) : null}
          </div>
          {drainBlockedReason ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CircleSlash className="size-3.5" aria-hidden /> {drainBlockedReason}
            </p>
          ) : pending > 0 ? (
            <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="size-3.5" aria-hidden /> Ready to send {pending} message
              {pending === 1 ? "" : "s"}.
            </p>
          ) : null}
        </>
      )}

      {/* Prepare popup — the SAME shared component the stages-list row uses. */}
      <StagePrepareDialog
        target={prepareTarget}
        onClose={() => setPrepareOpen(false)}
        onPrepared={refresh}
      />

      {/* Cancel prepared send confirmation. */}
      <AlertDialog open={confirmAbort} onOpenChange={setConfirmAbort}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this send and revert to editable?</AlertDialogTitle>
            <AlertDialogDescription>
              Discards the {pending.toLocaleString()} pending message{pending === 1 ? "" : "s"}{" "}
              materialized for this stage and un-approves it, so you can edit and re-prepare. Nothing
              has been sent yet. The schedule is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={abortApi.isLoading}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void abortArmed();
              }}
              disabled={abortApi.isLoading}
            >
              Cancel send
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Send-now (leftovers / manual drain) confirmation. */}
      <AlertDialog open={confirmDrain} onOpenChange={setConfirmDrain}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send {pending} message{pending === 1 ? "" : "s"} now?</AlertDialogTitle>
            <AlertDialogDescription>
              Real SMS will go out to {pending} recipient{pending === 1 ? "" : "s"} via TextHub.
              This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={drainApi.isLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void drain();
              }}
              disabled={drainApi.isLoading}
            >
              Send now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function GateBadge({ on, onLabel, offLabel }: { on: boolean; onLabel: string; offLabel: string }) {
  return (
    <span
      className={
        "inline-flex items-center rounded-md px-2 py-0.5 font-medium " +
        (on
          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
          : "bg-muted text-muted-foreground")
      }
    >
      {on ? onLabel : offLabel}
    </span>
  );
}
