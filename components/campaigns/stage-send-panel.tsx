"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleSlash } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/components/protected/auth-context";
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
  send_enabled: boolean;
  counts: { total: number; pending: number; sending: number; sent: number; failed: number };
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
  const approveApi = useApiCall<{ ok: boolean; send_approved: boolean }>();
  const kickoffApi = useApiCall<{ ok: boolean; materialized: number; mode: string }>();
  const drainApi = useApiCall<{
    ok: boolean;
    sent: number;
    failed: number;
    processed: number;
    halted: boolean;
    stuck: number;
    remaining: number;
  }>();
  const { execute: statusExec } = statusApi;

  const [status, setStatus] = useState<SendStatus | null>(null);
  const [tick, setTick] = useState(0);
  const [confirmDrain, setConfirmDrain] = useState(false);

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

  async function toggleApprove() {
    if (!status) return;
    const r = await approveApi.execute(
      `/api/campaigns/${campaignId}/stages/${stageId}/send/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: !status.send_approved }),
      },
    );
    if (!r.ok) {
      toastApiError(r, "Couldn't update approval");
      return;
    }
    toast.success(r.data.send_approved ? "Stage approved to send" : "Approval revoked");
    refresh();
  }

  async function kickoff() {
    const r = await kickoffApi.execute(
      `/api/campaigns/${campaignId}/stages/${stageId}/send/kickoff`,
      { method: "POST" },
    );
    if (!r.ok) {
      toastApiError(r, "Kickoff failed");
      return;
    }
    toast.success(`Materialized ${r.data.materialized} send${r.data.materialized === 1 ? "" : "s"} (${r.data.mode})`);
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
      `Sent ${d.sent}, failed ${d.failed}${d.halted ? " (halted)" : ""}${d.stuck ? `, ${d.stuck} stuck` : ""}`,
    );
    refresh();
  }

  if (!status) {
    return <p className="text-sm text-muted-foreground">Loading send status…</p>;
  }

  const pending = status.counts.pending;
  const drainBlockedReason = !canSend
    ? "Requires manager+ to send"
    : !status.send_enabled
      ? "Sending is globally off (set SEND_ENABLED)"
      : !status.send_approved
        ? "Approve the stage first"
        : pending === 0
          ? "Nothing pending to send"
          : null;

  return (
    <div className="space-y-4">
      {/* Gate states */}
      <div className="flex flex-wrap gap-2 text-xs">
        <GateBadge on={status.send_enabled} onLabel="SEND_ENABLED: on" offLabel="SEND_ENABLED: off" />
        <GateBadge on={status.send_approved} onLabel="Approved to send" offLabel="Not approved" />
      </div>

      {/* Live counts */}
      <div className="grid grid-cols-5 gap-2 text-center">
        {([
          ["Total", status.counts.total],
          ["Pending", status.counts.pending],
          ["Sending", status.counts.sending],
          ["Sent", status.counts.sent],
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

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        {canActivate ? (
          <Button variant="outline" onClick={() => void toggleApprove()} disabled={approveApi.isLoading}>
            {status.send_approved ? "Revoke approval" : "Approve to send"}
          </Button>
        ) : null}
        {canActivate ? (
          <Button variant="outline" onClick={() => void kickoff()} disabled={kickoffApi.isLoading}>
            Kick off (materialize + mint)
          </Button>
        ) : null}
        <Button
          onClick={() => setConfirmDrain(true)}
          disabled={drainBlockedReason !== null || drainApi.isLoading}
          title={drainBlockedReason ?? undefined}
        >
          {drainApi.isLoading ? "Sending…" : `Send now${pending > 0 ? ` (${pending})` : ""}`}
        </Button>
      </div>
      {drainBlockedReason ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CircleSlash className="size-3.5" aria-hidden /> {drainBlockedReason}
        </p>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="size-3.5" aria-hidden /> Ready to send {pending} message
          {pending === 1 ? "" : "s"}.
        </p>
      )}

      {/* Irreversible-send confirmation */}
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
