"use client";

import { cn } from "@/lib/utils";

// WS4 §B4 — volume-vs-caps meter. Org-wide count of messages sent on the current
// ET calendar day (a true "what went out today" total) against the aggregate 24h
// soft ceiling. Lets an operator see "9,200 / 10,000 today" before committing a
// big batch. Null cap ⇒ no API provider configured to meter against. NOTE: the
// breaker itself accounts in a rolling trailing-24h window (countSentSince), so
// near midnight this calendar-day figure can read lower than the breaker's view.
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
        <span className="font-medium text-muted-foreground">Sent today (ET)</span>
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
