"use client";

import * as React from "react";

import { Dialog, DialogContent } from "@/components/ui/dialog";

type DialogContentProps = React.ComponentProps<typeof DialogContent>;
type DialogRootProps = React.ComponentProps<typeof Dialog>;

export interface FormDialogProps
  extends Omit<DialogContentProps, "onPointerDownOutside" | "onEscapeKeyDown"> {
  open: DialogRootProps["open"];
  onOpenChange: DialogRootProps["onOpenChange"];
}

// Dialog wrapper for forms. Blocks accidental dismissal via backdrop click
// and Escape — long inputs (campaigns, stages, uploads) shouldn't evaporate
// from a stray click. The X button and any in-form Cancel button still close
// the dialog. Use the bare <Dialog> + <DialogContent> for read-only modals,
// and <AlertDialog> for short confirmations.
export function FormDialog({
  open,
  onOpenChange,
  children,
  ...contentProps
}: FormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        {...contentProps}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
