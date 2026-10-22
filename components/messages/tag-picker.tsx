"use client";

// P4: personalization tags in the creative editor — the picker, the worst-case
// length line and the unknown-token warning. Rendered only behind the
// message-formats UI flag (callers gate it).
import { Braces, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { calculateSmsSegments } from "@/lib/creative-helpers";
import { TAGS, TAG_KEYS, expandWorstCase, findTags, findUnknownTokens } from "@/lib/messages/tags";
import { cn } from "@/lib/utils";

export function TagPicker({ onInsert, disabled }: { onInsert: (token: string) => void; disabled?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button type="button" variant="outline" size="sm" className="h-7 gap-1 text-xs">
          <Braces className="size-3.5" aria-hidden />
          Insert tag
        </Button>
      </DropdownMenuTrigger>
      {/* Keep focus in the textarea insertAtCursor just focused, not back on the trigger. */}
      <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
        {TAG_KEYS.map((k) => (
          <DropdownMenuItem key={k} onSelect={() => onInsert(`{${k}}`)} className="gap-2">
            <span className="font-mono text-xs">{`{${k}}`}</span>
            <span className="text-muted-foreground">{TAGS[k].label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Insert `token` at the textarea's cursor (replacing any selection) and return the new value. */
export function insertAtCursor(el: HTMLTextAreaElement, token: string): string {
  el.setRangeText(token, el.selectionStart, el.selectionEnd, "end");
  // Refocus AFTER the menu has closed (it settles focus on close), with the
  // cursor right after the inserted tag.
  const caret = el.selectionEnd;
  setTimeout(() => {
    el.focus();
    el.setSelectionRange(caret, caret);
  }, 0);
  return el.value;
}

export function CreativeTagHints({ text, allowMultiSegment }: { text: string; allowMultiSegment: boolean }) {
  const hasTags = findTags(text).length > 0;
  const unknown = findUnknownTokens(text);
  if (!hasTags && unknown.length === 0) return null;
  const worst = hasTags ? calculateSmsSegments(expandWorstCase(text)) : null;
  return (
    <div className="grid gap-0.5 text-xs">
      {worst ? (
        <p
          className={cn(
            "tabular-nums",
            worst.segments > 1 && !allowMultiSegment ? "text-red-700 dark:text-red-400" : "text-muted-foreground",
          )}
        >
          Worst case: {worst.characters.toLocaleString()} characters · {worst.segments} segment
          {worst.segments === 1 ? "" : "s"}
        </p>
      ) : null}
      {unknown.map((t) => (
        <p key={t} className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>unknown tag {t} — will be sent literally</span>
        </p>
      ))}
    </div>
  );
}
