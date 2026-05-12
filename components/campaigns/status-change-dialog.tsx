"use client";

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
import { cn } from "@/lib/utils";

export type CampaignTransition =
  | "activate"
  | "pause"
  | "resume"
  | "complete"
  | "archive";

// Per-transition copy. Centralized so the same wording appears wherever a
// transition is triggered (list page actions, detail page actions).
const COPY: Record<
  CampaignTransition,
  { title: string; description: string; confirmLabel: string; destructive?: boolean }
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
      "Completed campaigns are read-only and no further stages can be created or sent. You can archive a completed campaign to hide it from the active list.",
    confirmLabel: "Mark complete",
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
}

export function StatusChangeDialog({
  transition,
  campaignName,
  isPending,
  onCancel,
  onConfirm,
}: StatusChangeDialogProps) {
  const copy = transition ? COPY[transition] : null;
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
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void onConfirm();
            }}
            disabled={isPending}
            className={cn(
              copy?.destructive &&
                "bg-destructive text-destructive-foreground hover:bg-destructive/90",
            )}
          >
            {copy?.confirmLabel ?? "Confirm"}
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
      return "active";
    case "pause":
      return "paused";
    case "complete":
      return "completed";
    case "archive":
      return "archived";
  }
}
