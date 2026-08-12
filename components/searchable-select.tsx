"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Check, ChevronDown, Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Single-select searchable dropdown — the single-select sibling of
// <MultiSelectPicker>. Same Radix Popover + filter-input shape, but it commits
// one value and closes on pick. Reach for this instead of a plain <Select>
// whenever the option list is long enough that scanning it is work (roughly
// >10 items). The trigger deliberately mirrors <SelectTrigger>'s styling so
// swapping one in doesn't shift the surrounding layout.
//
// Options are filtered in-memory. Scales to hundreds without virtualization,
// same as <MultiSelectPicker>.

export interface SearchableSelectOption {
  value: string;
  label: string;
  color?: string | null;
}

export interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value: string | null;
  onChange: (next: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  /** Shown inside the list when a search matches nothing. */
  emptyMessage?: string;
  disabled?: boolean;
  /** Applied to the trigger — this is where callers set width/height. */
  className?: string;
  // Shown on the trigger when `value` is set but is absent from `options`
  // (options haven't loaded yet, or the referenced entity is archived and no
  // longer in the active list). Mirrors the old <SelectValue> fallback path.
  fallbackLabel?: string;
  fallbackColor?: string | null;
  "aria-label"?: string;
}

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyMessage = "No matches",
  disabled = false,
  className,
  fallbackLabel,
  fallbackColor,
  "aria-label": ariaLabel,
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [focusedIndex, setFocusedIndex] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement | null>(null);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [search, options]);

  const selected = React.useMemo(
    () => (value === null ? undefined : options.find((o) => o.value === value)),
    [options, value],
  );

  // Open/close and search resets are handled in the event handlers below
  // rather than in effects — setState inside an effect body triggers a
  // cascading render (and trips react-hooks/set-state-in-effect).
  function handleOpenChange(next: boolean) {
    if (disabled) return;
    setOpen(next);
    if (next) {
      // Start each open clean, with the highlight on the current selection
      // rather than the top of the list — in a long list the selected row is
      // what the user orients from. Search is empty here, so `options` and
      // the rendered (filtered) list are the same thing.
      setSearch("");
      const i = options.findIndex((o) => o.value === value);
      setFocusedIndex(i >= 0 ? i : 0);
    }
  }

  // Typing re-filters the list, so the old index points at a different row.
  function handleSearchChange(next: string) {
    setSearch(next);
    setFocusedIndex(0);
  }

  // Keep the highlighted row visible during keyboard navigation.
  React.useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-ss-index="${focusedIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [focusedIndex, open]);

  function commit(next: string) {
    onChange(next);
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[focusedIndex];
      if (target) commit(target.value);
    }
  }

  // Three trigger states: a matched option, the caller's fallback (value set
  // but not in `options`), or the placeholder.
  const triggerLabel = selected?.label ?? (value !== null ? fallbackLabel : undefined);
  const triggerColor = selected ? selected.color : value !== null ? fallbackColor : undefined;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <PopoverPrimitive.Trigger
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        className={cn(
          "flex h-8 w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none",
          "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "dark:bg-input/30 dark:hover:bg-input/50",
          !triggerLabel && "text-muted-foreground",
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {triggerColor ? (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: triggerColor }}
              aria-hidden
            />
          ) : null}
          <span className="truncate">{triggerLabel ?? placeholder}</span>
        </span>
        <ChevronDown
          className="pointer-events-none size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className={cn(
            "z-50 rounded-md border bg-popover p-0 text-popover-foreground shadow-md outline-none",
            "data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          )}
          style={{
            width: "var(--radix-popover-trigger-width)",
            minWidth: "18rem",
          }}
          onKeyDown={handleKeyDown}
        >
          <div className="border-b p-2">
            <div className="relative">
              <Search
                className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder={searchPlaceholder}
                className="h-8 pl-7 text-sm"
                autoFocus
              />
            </div>
          </div>

          <div
            ref={listRef}
            className="max-h-[300px] overflow-y-auto py-1"
            role="listbox"
          >
            {filtered.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {emptyMessage}
              </p>
            ) : (
              filtered.map((o, i) => {
                const isSelected = o.value === value;
                const focused = i === focusedIndex;
                return (
                  <button
                    key={o.value}
                    type="button"
                    data-ss-index={i}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => commit(o.value)}
                    onMouseEnter={() => setFocusedIndex(i)}
                    className={cn(
                      "flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm",
                      focused && "bg-accent text-accent-foreground",
                    )}
                  >
                    <Check
                      className={cn(
                        "size-3.5 shrink-0",
                        isSelected ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden
                    />
                    {o.color ? (
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: o.color }}
                        aria-hidden
                      />
                    ) : null}
                    <span className="flex-1 truncate">{o.label}</span>
                  </button>
                );
              })
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
