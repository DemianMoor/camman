"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface CopyableIdProps {
  // The string to display + copy. NULL when the ID hasn't been generated
  // yet (e.g. draft campaign without brand/offer). When null, the input
  // shows `placeholder` text and the copy button is disabled.
  value: string | null;
  label: string;
  placeholder?: string;
  helperText?: string;
  // Toast message on successful copy. Defaults to `${label} copied`.
  copiedMessage?: string;
  className?: string;
  // Optional id for the input so external <Label htmlFor=...> works.
  id?: string;
}

// Read-only input with a copy-to-clipboard button. Used for system-
// generated identifiers (tracking_id) that users need to grab into
// external analytics URLs but never edit. Pair instances with the same
// styling treatment for visual consistency across forms.
export function CopyableId({
  value,
  label,
  placeholder = "—",
  helperText,
  copiedMessage,
  className,
  id,
}: CopyableIdProps) {
  const isEmpty = value == null || value.length === 0;
  const displayed = isEmpty ? placeholder : value;

  async function handleCopy() {
    if (isEmpty) return;
    try {
      await navigator.clipboard.writeText(value as string);
      toast.success(copiedMessage ?? `${label} copied`);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  }

  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-stretch gap-1.5">
        <Input
          id={id}
          readOnly
          value={displayed}
          className={cn(
            "bg-muted font-mono text-sm",
            isEmpty && "text-muted-foreground italic",
          )}
          // Select-on-focus so keyboard users can copy without the button.
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={handleCopy}
          disabled={isEmpty}
          aria-label={isEmpty ? `${label} not yet generated` : `Copy ${label}`}
          title={isEmpty ? undefined : `Copy ${label}`}
        >
          <Copy className="size-4" aria-hidden />
        </Button>
      </div>
      {helperText ? (
        <p className="text-xs text-muted-foreground">{helperText}</p>
      ) : null}
    </div>
  );
}
