"use client";

import { useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { Clock } from "lucide-react";

import {
  CAMPAIGN_TIMEZONE,
  CAMPAIGN_TIMEZONE_LABEL,
} from "@/lib/campaign-timezone";
import { cn } from "@/lib/utils";

// WS4 §B5 — send-window indicator. The auto-send window is the SENDER's fixed ET
// zone (a known v1 simplification — not recipient-local), so a scheduled stage
// only fires once that window is open. This makes "why didn't it fire overnight"
// legible: "Window opens 08:00 ET" / "open · closes in 3h 12m" / "window closed".
function fmtEt(iso: string): string {
  return formatInTimeZone(new Date(iso), CAMPAIGN_TIMEZONE, "HH:mm");
}

function humanizeUntil(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function SendWindowIndicator({
  opensAt,
  closesAt,
  className,
}: {
  opensAt: string | null;
  closesAt: string | null;
  className?: string;
}) {
  // Hold "now" in state (updated each minute) so "closes in …" stays roughly
  // live without reading an impure clock during render.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  if (!opensAt || !closesAt || now === null) return null;
  const open = Date.parse(opensAt);
  const close = Date.parse(closesAt);

  let label: string;
  let tone: string;
  if (now < open) {
    label = `Window opens ${fmtEt(opensAt)} ${CAMPAIGN_TIMEZONE_LABEL}`;
    tone = "text-muted-foreground";
  } else if (now < close) {
    label = `Window open · closes in ${humanizeUntil(close - now)}`;
    tone = "text-emerald-700 dark:text-emerald-400";
  } else {
    label = "Window closed for today";
    tone = "text-red-700 dark:text-red-400";
  }

  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", tone, className)}>
      <Clock className="size-3" aria-hidden />
      {label}
    </span>
  );
}
