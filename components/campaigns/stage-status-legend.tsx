"use client";

import { useState } from "react";
import { ChevronDown, HelpCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  STAGE_STATUS_META,
  STAGE_STATUS_ORDER,
} from "@/lib/stages/stage-status";

// WS4 §A5 — campaign-level status legend. Collapsed by default behind a small
// "Status guide" affordance; teaches the color system without cluttering the
// view for operators who already know it. Consumes the SAME §0 source as the
// row renderer — never a hardcoded copy.
/**
 * ⭐ A DRIP CAMPAIGN HAS A DIFFERENT ANSWER, so it gets a different guide.
 * The draft/sent lifecycle below describes a regular stage. A drip stage never
 * leaves 'draft' — nothing promotes it, because it is never materialized or
 * approved — and whether it sends is decided by `dripStageReadiness`. Showing
 * the regular legend on a drip campaign explains the wrong system.
 */
const DRIP_CONDITIONS: { label: string; meaning: string }[] = [
  { label: "Drip switched on", meaning: "org-wide drip posture is enabled and not paused" },
  { label: "Campaign active", meaning: "the campaign's status is active and it is not paused" },
  { label: "Stage active", meaning: "the stage's own Active toggle is on" },
  { label: "Window set", meaning: "both Opens and Closes are filled in — a half-set window never fires" },
];

export function StageStatusLegend({ variant = "regular" }: { variant?: "regular" | "drip" }) {
  const [open, setOpen] = useState(false);
  if (variant === "drip") {
    return (
      <div className="text-xs">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          aria-expanded={open}
        >
          <HelpCircle className="size-3.5" aria-hidden />
          Status guide
          <ChevronDown
            className={cn("size-3.5 transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </button>
        {open ? (
          <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-3">
            <p className="text-muted-foreground">
              A drip stage fires on its daily window, not on a scheduled date. It
              shows <span className="font-medium text-foreground">Active — will send</span>{" "}
              only when <em>all four</em> hold:
            </p>
            <ul className="space-y-1.5">
              {DRIP_CONDITIONS.map((c) => (
                <li key={c.label} className="flex items-start gap-2">
                  <span className="mt-0.5 size-2.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                  <span>
                    <span className="font-medium">{c.label}</span>
                    <span className="text-muted-foreground"> — {c.meaning}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              The badge names the first unmet one. The draft / sent statuses used
              by regular campaigns do not apply: a drip stage stays at draft for
              its whole life and that has no bearing on sending.
            </p>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        <HelpCircle className="size-3.5" aria-hidden />
        Status guide
        <ChevronDown
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>
      {open ? (
        <ul className="mt-2 space-y-1.5 rounded-md border bg-muted/30 p-3">
          {STAGE_STATUS_ORDER.map((key) => {
            const m = STAGE_STATUS_META[key];
            const loud =
              m.willSend === "unprepared" || m.willSend === "attention";
            return (
              <li key={key} className="flex items-start gap-2">
                <span
                  className={cn(
                    "mt-0.5 size-2.5 shrink-0 rounded-full",
                    m.swatchClass,
                  )}
                  aria-hidden
                />
                <span>
                  <span
                    className={cn("font-medium", loud && "text-foreground")}
                  >
                    {m.label}
                  </span>
                  <span className="text-muted-foreground"> — </span>
                  <span
                    className={cn(
                      "text-muted-foreground",
                      loud && "font-medium text-foreground",
                    )}
                  >
                    {m.meaning}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
