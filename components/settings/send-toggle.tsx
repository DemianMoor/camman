"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
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
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";

type SendSettings = {
  sends_enabled: boolean;
  env_enabled: boolean;
  updated_at: string | null;
  updated_by: { id: string; name: string | null; email: string | null } | null;
};

// The master "Live SMS sending" switch (Workstream 1). DB-backed daily on/off
// that, with the SEND_ENABLED env backstop, gates the real-send drain. Flipping
// is manager+ (campaigns.drain); every flip is audited server-side.
export function SendToggle() {
  const { can } = useAuth();
  const statusApi = useApiCall<SendSettings>();
  const putApi = useApiCall<{ ok: boolean; sends_enabled: boolean }>();
  const { execute: statusExec } = statusApi;

  const [state, setState] = useState<SendSettings | null>(null);
  const [tick, setTick] = useState(0);
  const [confirmOn, setConfirmOn] = useState(false);

  const canToggle = can("campaigns.drain");

  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await statusExec("/api/settings/sending");
      if (active && r.ok) setState(r.data);
    })();
    return () => {
      active = false;
    };
  }, [tick, statusExec]);

  async function apply(enabled: boolean) {
    const r = await putApi.execute("/api/settings/sending", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't update the sending switch");
      return;
    }
    toast.success(enabled ? "Live SMS sending is ON" : "Live SMS sending is OFF");
    setTick((n) => n + 1);
  }

  function onSwitch(next: boolean) {
    if (!canToggle) return;
    // Turning ON enables irreversible, money-spending sends — confirm first.
    // Turning OFF is the safe direction, so apply immediately.
    if (next) setConfirmOn(true);
    else void apply(false);
  }

  if (!state) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
      </p>
    );
  }

  const on = state.sends_enabled;

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-base font-medium">Live SMS sending</span>
              <span
                className={
                  "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium " +
                  (on
                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                    : "bg-muted text-muted-foreground")
                }
              >
                {on ? "ON" : "OFF"}
              </span>
            </div>
            <p className="max-w-prose text-sm text-muted-foreground">
              The master switch for sending real SMS through TextHub. While off,
              every send is refused — no redeploy needed to flip it. A stage still
              also needs its own approval and an un-paused provider to send.
            </p>
          </div>
          <Switch
            checked={on}
            disabled={!canToggle || putApi.isLoading}
            onCheckedChange={onSwitch}
            aria-label="Toggle live SMS sending"
          />
        </div>

        {/* Env backstop note — surfaced because it's a second, lower-level gate. */}
        {!state.env_enabled ? (
          <p className="flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
            The deploy-level backstop <code className="font-mono">SEND_ENABLED</code> is
            off, so sends are blocked regardless of this switch. Set it to{" "}
            <code className="font-mono">true</code> in the hosting env to use this
            control day-to-day.
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
            Deploy-level backstop <code className="font-mono">SEND_ENABLED</code> is on —
            this switch is the day-to-day control.
          </p>
        )}

        {state.updated_at ? (
          <p className="text-xs text-muted-foreground">
            Last changed {formatCampaignDateTime(state.updated_at)}
            {state.updated_by
              ? ` by ${state.updated_by.name ?? state.updated_by.email ?? "a teammate"}`
              : ""}
            .
          </p>
        ) : null}

        {!canToggle ? (
          <p className="text-xs text-muted-foreground">
            You can view this setting but only a manager or owner can change it.
          </p>
        ) : null}
      </CardContent>

      <AlertDialog open={confirmOn} onOpenChange={setConfirmOn}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn live SMS sending ON?</AlertDialogTitle>
            <AlertDialogDescription>
              This enables real SMS to go out org-wide via TextHub for any
              approved stage. Sending costs money and can&apos;t be undone once a
              message is submitted. You can switch it back off at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={putApi.isLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                setConfirmOn(false);
                void apply(true);
              }}
              disabled={putApi.isLoading}
            >
              Turn ON
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
