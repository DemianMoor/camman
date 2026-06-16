"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, PauseCircle, PowerOff } from "lucide-react";

import { cn } from "@/lib/utils";
import { useApiCall } from "@/lib/hooks/use-api-call";

// WS4 §B3 (= Bug 2 fix) — the persistent, app-level send-state strip. Surfaces
// the TWO operational states an operator must never lose track of, kept visually
// distinct from provider capability/"Active" badges:
//   • sends_enabled — the global live-sending master switch (Settings → Sending)
//   • send_paused   — per-provider circuit breaker (latched kill-switch)
// Plus a stuck-row pointer (B6). Lives in the app header so the real switch is
// never off-screen — the exact failure the live test exposed.

type SendState = {
  sends_enabled: boolean;
  env_enabled: boolean;
  effective_on: boolean;
  paused_providers: { id: number; name: string; reason: string | null }[];
  stuck_count: number;
};

export function SendStateStrip() {
  const api = useApiCall<SendState>();
  const { execute } = api;
  const [state, setState] = useState<SendState | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await execute("/api/sends/state");
      if (active && r.ok) setState(r.data);
    })();
    return () => {
      active = false;
    };
  }, [execute]);

  if (!state) return null;

  const on = state.effective_on;
  const offReason = !state.env_enabled
    ? "deploy backstop SEND_ENABLED is off"
    : "turn it on in Settings → Sending";
  const paused = state.paused_providers;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {/* Global master switch — always shown. */}
      <Link
        href="/settings/sending"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-medium",
          on
            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
            : "bg-destructive/10 text-destructive",
        )}
        title={
          on
            ? "Live SMS sending is ON (global master switch)"
            : `Live SMS sending is OFF — ${offReason}`
        }
      >
        {on ? (
          <CheckCircle2 className="size-3.5" aria-hidden />
        ) : (
          <PowerOff className="size-3.5" aria-hidden />
        )}
        Live sending: {on ? "ON" : "OFF"}
      </Link>

      {/* Per-provider breaker(s) — only when something is latched. */}
      {paused.map((p) => (
        <Link
          key={p.id}
          href={`/providers/${p.id}`}
          className="inline-flex items-center gap-1.5 rounded-md bg-destructive/10 px-2 py-0.5 font-medium text-destructive"
          title={p.reason ? `Paused: ${p.reason}` : "Provider send paused"}
        >
          <PauseCircle className="size-3.5" aria-hidden />
          {p.name} paused
        </Link>
      ))}

      {/* Stuck rows (B6) — process died mid-send; never auto-retried. */}
      {state.stuck_count > 0 ? (
        <Link
          href="/sends/today"
          className="inline-flex items-center gap-1.5 rounded-md bg-amber-100 px-2 py-0.5 font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200"
          title="Messages stuck in 'sending' — review"
        >
          <AlertTriangle className="size-3.5" aria-hidden />
          {state.stuck_count} stuck
        </Link>
      ) : null}
    </div>
  );
}
