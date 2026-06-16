"use client";

import { cn } from "@/lib/utils";

// WS4 §B4 — volume-vs-caps meter. Today's org-wide sent count against the
// aggregate 24h soft ceiling (matches the breaker's org-wide accounting). Lets
// an operator see "9,200 / 10,000 today" before committing a big batch and
// hitting a soft pause. Null cap ⇒ no API provider configured to meter against.
export function VolumeCapsMeter({
  sent,
  cap,
  className,
}: {
  sent: number;
  cap: number | null;
  className?: string;
}) {
  const pct = cap && cap > 0 ? Math.min(100, (sent / cap) * 100) : 0;
  const near = cap != null && pct >= 80;
  const over = cap != null && sent >= cap;

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-muted-foreground">Sent today (24h)</span>
        <span className="font-mono tabular-nums">
          {sent.toLocaleString()}
          {cap != null ? ` / ${cap.toLocaleString()}` : ""}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            over
              ? "bg-red-500"
              : near
                ? "bg-amber-500"
                : "bg-emerald-500",
          )}
          style={{ width: cap != null ? `${pct}%` : "0%" }}
        />
      </div>
      {cap == null ? (
        <p className="text-[11px] text-muted-foreground">
          No API provider configured.
        </p>
      ) : over ? (
        <p className="text-[11px] font-medium text-red-700 dark:text-red-400">
          24h ceiling reached — further sends will soft-pause until the window rolls.
        </p>
      ) : near ? (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          Approaching the 24h soft ceiling.
        </p>
      ) : null}
    </div>
  );
}
