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
export function StageStatusLegend() {
  const [open, setOpen] = useState(false);
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
