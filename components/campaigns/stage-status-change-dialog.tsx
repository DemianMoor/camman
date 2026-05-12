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

// Stage state machine targets. Mirrors the API's TRANSITIONS map plus the
// few user-facing labels for the action items in the three-dots menu.
// Kept separate from the campaign-status dialog because the copy is
// stage-specific enough that generalizing was more code than duplicating.
export type StageTransition =
  | "to_pending"
  | "to_draft"
  | "to_sent"
  | "to_success"
  | "to_cancelled"
  | "to_failed";

const COPY: Record<
  StageTransition,
  {
    title: string;
    description: string;
    confirmLabel: string;
    destructive?: boolean;
  }
> = {
  to_pending: {
    title: "Mark this stage pending?",
    description:
      "Pending stages are queued for sending — typically once you've assembled the phone list and prepped the provider on the other side.",
    confirmLabel: "Mark pending",
  },
  to_draft: {
    title: "Return this stage to draft?",
    description:
      "Useful if you want to tweak the creative or filters before sending.",
    confirmLabel: "Back to draft",
  },
  to_sent: {
    title: "Mark this stage as sent?",
    description:
      "Records the send timestamp. Use this after you've actually pushed the phone list to your SMS provider. Results can be imported later.",
    confirmLabel: "Mark sent",
  },
  to_success: {
    title: "Mark this stage successful?",
    description:
      "Records that the send completed cleanly. This is terminal — the stage can be archived from here but not re-sent.",
    confirmLabel: "Mark successful",
  },
  to_cancelled: {
    title: "Cancel this stage?",
    description:
      "Use this when the stage is no longer needed. Terminal — can only be archived afterward.",
    confirmLabel: "Cancel stage",
    destructive: true,
  },
  to_failed: {
    title: "Mark this stage failed?",
    description:
      "Use this if the provider rejected the send or you discovered a problem afterward. Terminal — can be archived later.",
    confirmLabel: "Mark failed",
    destructive: true,
  },
};

export interface StageStatusChangeDialogProps {
  transition: StageTransition | null;
  stageLabel: string | null;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

export function StageStatusChangeDialog({
  transition,
  stageLabel,
  isPending,
  onCancel,
  onConfirm,
}: StageStatusChangeDialogProps) {
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
            {stageLabel ? (
              <span className="block pb-1 font-medium text-foreground">
                {stageLabel}
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

export function transitionToStageStatus(t: StageTransition): string {
  switch (t) {
    case "to_pending":
      return "pending";
    case "to_draft":
      return "draft";
    case "to_sent":
      return "sent";
    case "to_success":
      return "success";
    case "to_cancelled":
      return "cancelled";
    case "to_failed":
      return "failed";
  }
}
