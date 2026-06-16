"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, PowerOff } from "lucide-react";

import { useApiCall } from "@/lib/hooks/use-api-call";

// Global "Live sending" master-state indicator (Bug 2). The one switch that
// actually gates sending is otherwise the least-visible state in the app and is
// surrounded by unrelated provider "Active" badges. This surfaces it
// unambiguously on every surface where an operator commits or reviews a send.
//
// Single source of truth: GET /api/settings/sending. Effective live state is the
// two-switch conjunction — the DB master switch (org_settings.sends_enabled) AND
// the deploy backstop (SEND_ENABLED). Distinct from a provider's send_paused
// breaker and from provider/API/phone "Active" capability badges.
type SendSettings = { sends_enabled: boolean; env_enabled: boolean };

export function LiveSendingBanner({
  variant = "strip",
}: {
  variant?: "strip" | "inline";
}) {
  const api = useApiCall<SendSettings>();
  const { execute } = api;
  const [state, setState] = useState<SendSettings | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await execute("/api/settings/sending");
      if (active && r.ok) setState(r.data);
    })();
    return () => {
      active = false;
    };
  }, [execute]);

  if (!state) return null;

  const on = state.sends_enabled && state.env_enabled;
  // Why it's off: the deploy backstop wins (operator can't fix it from the UI),
  // otherwise it's the Settings switch (one click away).
  const offReason = !state.env_enabled
    ? "deploy backstop SEND_ENABLED is off"
    : "turn it on in Settings → Sending";

  if (variant === "inline") {
    return (
      <span
        className={
          "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium " +
          (on
            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
            : "bg-destructive/10 text-destructive")
        }
        title={on ? "Live SMS sending is ON" : `Live SMS sending is OFF — ${offReason}`}
      >
        {on ? <CheckCircle2 className="size-3.5" aria-hidden /> : <PowerOff className="size-3.5" aria-hidden />}
        Live sending: {on ? "ON" : "OFF"}
      </span>
    );
  }

  return (
    <div
      className={
        "flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm " +
        (on
          ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
          : "border-destructive/40 bg-destructive/5 text-destructive")
      }
    >
      {on ? (
        <CheckCircle2 className="size-4 shrink-0" aria-hidden />
      ) : (
        <PowerOff className="size-4 shrink-0" aria-hidden />
      )}
      <span className="font-medium">Live sending: {on ? "ON" : "OFF"}</span>
      <span className="opacity-80">
        {on
          ? "— the global master switch is on; real SMS can go out (a stage still needs its own approval and an un-paused provider)."
          : `— no SMS can go out (${offReason}).`}
      </span>
      {!on && state.env_enabled ? (
        <Link href="/settings/sending" className="font-medium underline underline-offset-2">
          Open Settings → Sending
        </Link>
      ) : null}
    </div>
  );
}
