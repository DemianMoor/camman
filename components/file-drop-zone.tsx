"use client";

import { useId, useRef, useState } from "react";
import { FileUp, Upload } from "lucide-react";

import { cn } from "@/lib/utils";

export interface FileDropZoneProps {
  // Comma-separated list passed straight to the <input accept="…">.
  accept: string;
  onFile: (file: File) => void;
  disabled?: boolean;
  // Lets callers override the default copy without re-styling the box.
  hint?: string;
  // Optional: shown when a file is loaded, e.g. "myfile.csv — 42 rows".
  selectedSummary?: { name: string; meta?: string } | null;
  className?: string;
}

// Single source of truth for any "pick a file via click OR drop" UI.
// Wraps a visually-hidden <input type="file"> in a clickable + dropable
// surface. Validates only by file-input accept attribute and by passing
// the File through to onFile; mime/extension verification beyond that
// stays with the caller because the caller knows what content it wants.
export function FileDropZone({
  accept,
  onFile,
  disabled,
  hint,
  selectedSummary,
  className,
}: FileDropZoneProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  function handleSelect(file: File | null | undefined) {
    if (!file) return;
    onFile(file);
    // Reset input so the SAME file can be selected again after a remove.
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <label
      htmlFor={inputId}
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        if (!isDragOver) setIsDragOver(true);
      }}
      onDragLeave={() => {
        if (disabled) return;
        setIsDragOver(false);
      }}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        setIsDragOver(false);
        const file = e.dataTransfer.files?.[0];
        handleSelect(file);
      }}
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed bg-muted/20 px-4 py-6 text-sm transition-colors",
        disabled
          ? "cursor-not-allowed opacity-60"
          : isDragOver
            ? "cursor-copy border-primary bg-primary/5"
            : "cursor-pointer border-muted-foreground/30 hover:border-muted-foreground/60 hover:bg-muted/40",
        className,
      )}
    >
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={(e) => handleSelect(e.target.files?.[0])}
        className="sr-only"
      />
      {selectedSummary ? (
        <div className="flex items-center gap-2 font-medium">
          <FileUp className="size-4" aria-hidden />
          <span>{selectedSummary.name}</span>
          {selectedSummary.meta ? (
            <span className="text-muted-foreground">
              — {selectedSummary.meta}
            </span>
          ) : null}
        </div>
      ) : (
        <>
          <Upload
            className={cn(
              "size-6",
              isDragOver ? "text-primary" : "text-muted-foreground",
            )}
            aria-hidden
          />
          <div className="text-center">
            <p className="font-medium">
              {hint ?? "Click to select or drag a file here"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Accepts {accept}
            </p>
          </div>
        </>
      )}
    </label>
  );
}
