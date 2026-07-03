"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleSlash } from "lucide-react";
import { toast } from "sonner";

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
import { toastApiError } from "@/lib/api/toast-error";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { calculateSmsSegments } from "@/lib/creative-helpers";
import { useApiCall } from "@/lib/hooks/use-api-call";

// WS4 §A2 — the ONE Prepare confirm popup, shared by every entry point (the
// stages-list row and the stage editor). "Prepare" = approve + materialize +
// mint links (creates stage_sends rows). The readiness checklist appears here
// regardless of where Prepare was clicked — the list-row path is the one most
// likely fired on a half-configured stage, so it must NOT skip pre-flight.
//
// Terminology is LOCKED: action = "Prepare", resulting state = "Prepared".
// Never "Arm"/"Armed".

export type PrepareTarget = {
  campaignId: number;
  stageId: number;
  /** Stage label for the toast/title context. */
  stageLabel?: string | null;
  scheduledAt: string | null;
  scheduleMissedAt: string | null;
};

type PreflightResult = {
  ok: boolean;
  mode: string;
  recipient_count: number;
  blockers: string[];
  checks: { key: string; ok: boolean; label: string }[];
  preview_text: string | null;
};

export function StagePrepareDialog({
  target,
  onClose,
  onPrepared,
}: {
  target: PrepareTarget | null;
  onClose: () => void;
  onPrepared?: () => void;
}) {
  const preflightApi = useApiCall<PreflightResult>();
  const approveSendApi = useApiCall<{
    ok: boolean;
    mode: string;
    armed: boolean;
    sent_now: boolean;
    materialized: number;
    // true when the server hit its time budget mid-materialization — the cron
    // finishes the rest before the send window.
    materializing?: boolean;
    scheduled_at?: string | null;
    drain?: { sent: number; failed: number; halted: boolean; stuck: number };
  }>();
  const { execute: preflightExec } = preflightApi;

  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  // Live materialization progress (rows written so far), polled while the
  // approve-send call runs so the operator sees movement, not a frozen button.
  const [materialized, setMaterialized] = useState(0);

  // A future schedule that hasn't been marked missed → Prepare arms it for the
  // scheduled window; otherwise Prepare sends now (manager+ only). The server
  // makes the authoritative arm-vs-now call from the real clock at commit.
  const willSchedule =
    target?.scheduledAt != null && target?.scheduleMissedAt == null;

  // Keep onClose in a ref so the preflight effect doesn't re-fire when the
  // parent passes a fresh callback identity each render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Run pre-flight when a target opens — keyed on the primitive ids so an inline
  // target object (rebuilt each parent render) doesn't re-trigger the fetch.
  const campaignId = target?.campaignId ?? null;
  const stageId = target?.stageId ?? null;
  useEffect(() => {
    if (campaignId == null || stageId == null) {
      setPreflight(null);
      return;
    }
    let active = true;
    void (async () => {
      const r = await preflightExec(
        `/api/campaigns/${campaignId}/stages/${stageId}/send/preflight`,
        { method: "POST" },
      );
      if (!active) return;
      if (!r.ok) {
        toastApiError(r, "Couldn't run pre-flight checks");
        onCloseRef.current();
        return;
      }
      setPreflight(r.data);
    })();
    return () => {
      active = false;
    };
  }, [campaignId, stageId, preflightExec]);

  async function confirmPrepare() {
    if (!target) return;
    // Poll the read-only progress endpoint while approve-send materializes, so a
    // large stage shows a live "Materializing N/total…" bar instead of freezing.
    setMaterialized(0);
    const poll = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch(
            `/api/campaigns/${target.campaignId}/stages/${target.stageId}/send/materialize-progress`,
          );
          if (res.ok) {
            const j = (await res.json()) as { materialized?: number };
            setMaterialized(j.materialized ?? 0);
          }
        } catch {
          // transient poll failure — the next tick retries; ignore.
        }
      })();
    }, 1500);

    let r;
    try {
      r = await approveSendApi.execute(
        `/api/campaigns/${target.campaignId}/stages/${target.stageId}/send/approve-send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Explicit send-now (no future schedule) → the server stamps
          // scheduled_at = now() so the send passes the no-schedule guard. A
          // future schedule arms instead (send_now: false).
          body: JSON.stringify({ send_now: !willSchedule }),
        },
      );
    } finally {
      clearInterval(poll);
    }
    if (!r.ok) {
      toastApiError(r, "Prepare failed");
      return;
    }
    if (r.data.materializing) {
      // Budget hit mid-materialization — the scheduled-send cron finishes the
      // remainder before the send window. Tell the operator it's continuing.
      toast.success(
        `Materializing ${r.data.materialized.toLocaleString()} so far — the rest continues in the background and sends at the scheduled time.`,
      );
      onClose();
      onPrepared?.();
      return;
    }
    if (r.data.armed) {
      toast.success(
        `Prepared — ${r.data.materialized.toLocaleString()} message${r.data.materialized === 1 ? "" : "s"} will send automatically at the scheduled time.`,
      );
    } else {
      const d = r.data.drain;
      toast.success(
        d
          ? `Submitted ${d.sent} (accepted by TextHub), failed ${d.failed}${d.halted ? " (halted)" : ""}${d.stuck ? `, ${d.stuck} stuck` : ""}`
          : "Prepared",
      );
    }
    onClose();
    onPrepared?.();
  }

  const open = target != null;
  const seg = preflight?.preview_text
    ? calculateSmsSegments(preflight.preview_text)
    : null;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <AlertDialogContent>
        {!preflight ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Checking readiness…</AlertDialogTitle>
              <AlertDialogDescription>
                Running pre-flight checks before preparing this stage.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
            </AlertDialogFooter>
          </>
        ) : !preflight.ok ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Not ready to prepare</AlertDialogTitle>
              <AlertDialogDescription>
                Resolve these before preparing — nothing was materialized:
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ul className="space-y-1 text-sm">
              {preflight.checks
                .filter((c) => !c.ok)
                .map((c) => (
                  <li
                    key={c.key}
                    className="flex items-center gap-1.5 text-destructive"
                  >
                    <CircleSlash className="size-3.5 shrink-0" aria-hidden />{" "}
                    {c.label}
                  </li>
                ))}
            </ul>
            <AlertDialogFooter>
              <AlertDialogCancel>Close</AlertDialogCancel>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {willSchedule
                  ? `Prepare ${preflight.recipient_count.toLocaleString()} message${preflight.recipient_count === 1 ? "" : "s"}?`
                  : `Prepare & send ${preflight.recipient_count.toLocaleString()} message${preflight.recipient_count === 1 ? "" : "s"} now?`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {willSchedule
                  ? `Materialized now and sent automatically at ${target?.scheduledAt ? formatCampaignDateTime(target.scheduledAt) : "the scheduled time"}, once the send window is open. You can cancel before then.`
                  : `Real SMS will go out to ${preflight.recipient_count.toLocaleString()} recipient${preflight.recipient_count === 1 ? "" : "s"} via TextHub. This can't be undone.`}
              </AlertDialogDescription>
            </AlertDialogHeader>

            {/* Readiness checklist — shown regardless of entry point. */}
            <ul className="space-y-1 text-xs text-muted-foreground">
              {preflight.checks.map((c) => (
                <li key={c.key} className="flex items-center gap-1.5">
                  {c.ok ? (
                    <CheckCircle2
                      className="size-3.5 shrink-0 text-emerald-600"
                      aria-hidden
                    />
                  ) : (
                    <CircleSlash
                      className="size-3.5 shrink-0 text-destructive"
                      aria-hidden
                    />
                  )}
                  {c.label}
                </li>
              ))}
            </ul>

            {/* Message preview + segment count (link added per recipient). */}
            {preflight.preview_text ? (
              <div className="space-y-1">
                <div className="text-[11px] uppercase text-muted-foreground">
                  Message preview
                </div>
                <pre className="whitespace-pre-wrap rounded-md bg-muted/40 p-2.5 font-mono text-xs">
                  {preflight.preview_text}
                </pre>
                {seg ? (
                  <div className="text-[11px] tabular-nums text-muted-foreground">
                    {seg.characters.toLocaleString()} characters · {seg.segments}{" "}
                    segment{seg.segments === 1 ? "" : "s"} ({seg.charset}) · a
                    unique link is added per recipient
                  </div>
                ) : null}
              </div>
            ) : null}

            {!willSchedule ? (
              <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                No schedule set — this sends immediately on confirm.
              </p>
            ) : null}

            {/* Live materialization progress — appears once Prepare is running so
                a large stage shows a moving count instead of a frozen button. */}
            {approveSendApi.isLoading ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Materializing recipients…</span>
                  <span className="tabular-nums">
                    {materialized.toLocaleString()} /{" "}
                    {preflight.recipient_count.toLocaleString()}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-500"
                    style={{
                      width: `${Math.min(
                        100,
                        preflight.recipient_count > 0
                          ? Math.round((materialized / preflight.recipient_count) * 100)
                          : 0,
                      )}%`,
                    }}
                  />
                </div>
              </div>
            ) : null}

            <AlertDialogFooter>
              <AlertDialogCancel disabled={approveSendApi.isLoading}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  void confirmPrepare();
                }}
                disabled={approveSendApi.isLoading}
              >
                {approveSendApi.isLoading
                  ? "Working…"
                  : willSchedule
                    ? "Prepare"
                    : "Prepare & send now"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
