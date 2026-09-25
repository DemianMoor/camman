"use client";

import { AlertTriangle } from "lucide-react";

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
import {
  EXCL_TIMING_WARNING_TEXT,
  exclDialogState,
  type ExclTimingInput,
} from "@/lib/campaigns/excl-timing-warning";
import { cn } from "@/lib/utils";

export type CampaignTransition =
  "activate" | "pause" | "resume" | "complete" | "reactivate" | "archive";

// Per-transition copy. Centralized so the same wording appears wherever a
// transition is triggered (list page actions, detail page actions).
const COPY: Record<
  CampaignTransition,
  {
    title: string;
    description: string;
    confirmLabel: string;
    destructive?: boolean;
  }
> = {
  activate: {
    title: "Activate this campaign?",
    description:
      "Once active, the audience is frozen at its current snapshot. You can still pause or mark it complete later, but the audience pool can't be changed.",
    confirmLabel: "Activate",
  },
  pause: {
    title: "Pause this campaign?",
    description:
      "Pausing temporarily blocks new stage sends. You can resume it any time without affecting the frozen audience.",
    confirmLabel: "Pause",
  },
  resume: {
    title: "Resume this campaign?",
    description:
      "Resuming returns the campaign to active. The frozen audience and prior stages remain unchanged.",
    confirmLabel: "Resume",
  },
  complete: {
    title: "Mark this campaign complete?",
    description:
      "No further stages will send. You can reactivate the campaign later if needed, or archive it to remove it from the active list.",
    confirmLabel: "Mark complete",
  },
  reactivate: {
    title: "Reactivate this campaign?",
    description:
      "The campaign returns to active with its existing frozen audience. New stages can be created and sent.",
    confirmLabel: "Reactivate",
  },
  archive: {
    title: "Archive this campaign?",
    description:
      "Archived campaigns are hidden from the active list. The data is preserved and you can restore later if needed.",
    confirmLabel: "Archive",
  },
};

export interface StatusChangeDialogProps {
  transition: CampaignTransition | null;
  campaignName: string | null;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
  // PR 4b. The Excl-timing inputs for an `activate` transition, or null when
  // the caller has nothing to say (not activating, or a legacy campaign).
  //
  // `undefined` and `null` mean different things: undefined = the caller is
  // still FETCHING and the answer is not known yet, so confirm is held;
  // null = the caller knows there is nothing to warn about. A dialog that
  // could be confirmed before its warning appeared would be worse than one
  // that waits (owner decision, 2026-09-25).
  exclTiming?: ExclTimingInput | null;
}

export function StatusChangeDialog({
  transition,
  campaignName,
  isPending,
  onCancel,
  onConfirm,
  exclTiming,
}: StatusChangeDialogProps) {
  const copy = transition ? COPY[transition] : null;
  // Only `activate` freezes the audience, so only it can have this gap.
  const { awaiting: awaitingExcl, warn: warnExcl } = exclDialogState(
    transition === "activate",
    exclTiming,
  );
  return (
    <AlertDialog
      open={transition !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy?.title ?? ""}</AlertDialogTitle>
          <AlertDialogDescription>
            {campaignName ? (
              <span className="block pb-1 font-medium text-foreground">
                {campaignName}
              </span>
            ) : null}
            {copy?.description ?? ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {warnExcl ? (
          <div className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{EXCL_TIMING_WARNING_TEXT}</span>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void onConfirm();
            }}
            disabled={isPending || awaitingExcl}
            className={cn(
              copy?.destructive &&
                "bg-destructive text-destructive-foreground hover:bg-destructive/90",
            )}
          >
            {awaitingExcl ? "Checking…" : (copy?.confirmLabel ?? "Confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Maps a transition action to the API's target status value.
export function transitionToStatus(t: CampaignTransition): string {
  switch (t) {
    case "activate":
    case "resume":
    case "reactivate":
      return "active";
    case "pause":
      return "paused";
    case "complete":
      return "completed";
    case "archive":
      return "archived";
  }
}
