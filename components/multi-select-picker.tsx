"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Check, ChevronDown, Loader2, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Generic, fully-controlled multi-select dropdown for entity selection.
// Scales to hundreds of options without virtualization (native scroll-y).
// TODO: consider virtualization (e.g. react-window) if any list exceeds
// ~1000 options. We're nowhere near that today.

export interface MultiSelectOption {
  id: number | string;
  label: string;
  color?: string | null;
  avatarUrl?: string | null;
  meta?: string;
}

export interface MultiSelectPickerProps {
  options: MultiSelectOption[];
  value: (number | string)[];
  onChange: (next: (number | string)[]) => void;
  placeholder?: string;
  selectedLabel?: (count: number) => string;
  isLoading?: boolean;
  disabled?: boolean;
  emptyMessage?: string;
  searchPlaceholder?: string;
  maxChipsShown?: number;
  className?: string;
}

function defaultSelectedLabel(n: number): string {
  return `${n.toLocaleString()} selected`;
}

export function MultiSelectPicker({
  options,
  value,
  onChange,
  placeholder = "Select items…",
  selectedLabel = defaultSelectedLabel,
  isLoading = false,
  disabled = false,
  emptyMessage = "No options available.",
  searchPlaceholder = "Search…",
  maxChipsShown = 5,
  className,
}: MultiSelectPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [focusedIndex, setFocusedIndex] = React.useState(0);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);

  const selectedSet = React.useMemo(() => new Set(value), [value]);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [search, options]);

  // Reset focused index when filter changes.
  React.useEffect(() => {
    setFocusedIndex(0);
  }, [search]);

  // Reset search when popover closes.
  React.useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  // Scroll the focused item into view when navigating with keyboard.
  React.useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-msp-index="${focusedIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [focusedIndex, open]);

  const noOptionsAtAll =
    !isLoading && options.length === 0;
  const triggerDisabled = disabled || isLoading || noOptionsAtAll;
  const selectedCount = value.length;

  function toggle(id: number | string) {
    if (selectedSet.has(id)) {
      onChange(value.filter((v) => v !== id));
    } else {
      onChange([...value, id]);
    }
  }

  function handleSelectAllVisible() {
    const visibleIds = filtered.map((o) => o.id);
    const next = Array.from(new Set([...value, ...visibleIds]));
    onChange(next);
  }

  function handleClear() {
    onChange([]);
  }

  function handleListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[focusedIndex];
      if (target) toggle(target.id);
    }
  }

  // Chip display below the trigger. Truncates beyond maxChipsShown.
  const chipOptions = React.useMemo(() => {
    const byId = new Map(options.map((o) => [o.id, o] as const));
    return value
      .map((id) => byId.get(id))
      .filter((o): o is MultiSelectOption => o !== undefined);
  }, [options, value]);
  const visibleChips = chipOptions.slice(0, maxChipsShown);
  const extraChips = chipOptions.length - visibleChips.length;

  return (
    <div className={cn("grid gap-2", className)}>
      <PopoverPrimitive.Root
        open={open}
        onOpenChange={(o) => {
          if (triggerDisabled) return;
          setOpen(o);
        }}
      >
        <PopoverPrimitive.Trigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="outline"
            disabled={triggerDisabled}
            className={cn(
              "w-full justify-between font-normal",
              selectedCount === 0 && "text-muted-foreground",
            )}
          >
            <span className="truncate text-left">
              {isLoading
                ? "Loading…"
                : noOptionsAtAll
                  ? emptyMessage
                  : selectedCount === 0
                    ? placeholder
                    : selectedLabel(selectedCount)}
            </span>
            {isLoading ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <ChevronDown
                className="size-4 opacity-60"
                aria-hidden
              />
            )}
          </Button>
        </PopoverPrimitive.Trigger>

        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            align="start"
            sideOffset={4}
            className={cn(
              "z-50 rounded-md border bg-popover p-0 shadow-md outline-none",
              "data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
            )}
            style={{
              width: "var(--radix-popover-trigger-width)",
              minWidth: "16rem",
            }}
            onKeyDown={handleListKeyDown}
          >
            <div className="border-b p-2">
              <div className="relative">
                <Search
                  className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={searchPlaceholder}
                  className="h-8 pl-7 text-sm"
                  autoFocus
                />
              </div>
              <div className="flex items-center justify-between pt-2 text-xs">
                <button
                  type="button"
                  onClick={handleSelectAllVisible}
                  className="text-muted-foreground hover:text-foreground"
                  disabled={filtered.length === 0}
                >
                  Select all{search ? " (filtered)" : ""}
                </button>
                <button
                  type="button"
                  onClick={handleClear}
                  className="text-muted-foreground hover:text-foreground"
                  disabled={value.length === 0}
                >
                  Clear
                </button>
              </div>
            </div>

            <div
              ref={listRef}
              className="max-h-[300px] overflow-y-auto py-1"
              role="listbox"
              aria-multiselectable
            >
              {filtered.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No matches
                </p>
              ) : (
                filtered.map((o, i) => {
                  const checked = selectedSet.has(o.id);
                  const focused = i === focusedIndex;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      data-msp-index={i}
                      role="option"
                      aria-selected={checked}
                      onClick={() => toggle(o.id)}
                      onMouseEnter={() => setFocusedIndex(i)}
                      className={cn(
                        "flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm",
                        focused && "bg-accent",
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded border",
                          checked
                            ? "border-foreground bg-foreground text-background"
                            : "border-muted-foreground/40 bg-background",
                        )}
                        aria-hidden
                      >
                        {checked ? <Check className="size-3" /> : null}
                      </span>
                      {o.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={o.avatarUrl}
                          alt=""
                          className="size-4 shrink-0 rounded-full"
                        />
                      ) : o.color ? (
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: o.color }}
                          aria-hidden
                        />
                      ) : null}
                      <span className="flex-1 truncate">{o.label}</span>
                      {o.meta ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {o.meta}
                        </span>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>

      {chipOptions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {visibleChips.map((o) => (
            <span
              key={o.id}
              className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-xs"
            >
              {o.color ? (
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: o.color }}
                  aria-hidden
                />
              ) : null}
              <span className="max-w-[12rem] truncate">{o.label}</span>
              <button
                type="button"
                aria-label={`Remove ${o.label}`}
                disabled={disabled || isLoading}
                onClick={() => toggle(o.id)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
          {extraChips > 0 ? (
            <span
              className="inline-flex items-center rounded-full border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              title={chipOptions
                .slice(maxChipsShown)
                .map((o) => o.label)
                .join(", ")}
            >
              +{extraChips} more
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
