"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import {
  Check,
  ChevronDown,
  Loader2,
  Search,
  Star,
  StarOff,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  isAutoNamedSegment,
  useSegmentPrefs,
} from "@/lib/hooks/use-segment-prefs";
import { cn } from "@/lib/utils";

// Shape matches campaign-form-state.SegmentInfo. Inlined here so this
// component doesn't import from campaign-* (segments code shouldn't
// depend on campaign code).
export interface SegmentForPicker {
  id: number;
  name: string;
  segment_id: string;
  stats: { total_count: number };
  active_rules_count?: number;
}

export interface SegmentPickerProps {
  segments: SegmentForPicker[];
  value: number[];
  onChange: (next: number[]) => void;
  isLoading?: boolean;
  disabled?: boolean;
  className?: string;
}

type FilterTab = "all" | "rules" | "static" | "recent" | "pinned";

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "rules", label: "Has rules" },
  { key: "static", label: "Static" },
  { key: "recent", label: "Recent" },
  { key: "pinned", label: "Pinned" },
];

export function SegmentPicker({
  segments,
  value,
  onChange,
  isLoading = false,
  disabled = false,
  className,
}: SegmentPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [tab, setTab] = React.useState<FilterTab>("all");
  const { pinnedIds, recentIds, togglePin, pushRecent } = useSegmentPrefs();

  React.useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const selectedSet = React.useMemo(() => new Set(value), [value]);
  const pinnedSet = React.useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const recentSet = React.useMemo(() => new Set(recentIds), [recentIds]);

  // Filter by search + tab.
  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return segments.filter((s) => {
      if (q) {
        const hay = `${s.name} ${s.segment_id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      const hasRules = (s.active_rules_count ?? 0) > 0;
      if (tab === "rules" && !hasRules) return false;
      if (tab === "static" && hasRules) return false;
      if (tab === "recent" && !recentSet.has(s.id)) return false;
      if (tab === "pinned" && !pinnedSet.has(s.id)) return false;
      return true;
    });
  }, [segments, search, tab, recentSet, pinnedSet]);

  // Group: pinned first, then recent (in MRU order), then everything else.
  const groups = React.useMemo(() => {
    const pinned: SegmentForPicker[] = [];
    const recent: SegmentForPicker[] = [];
    const rest: SegmentForPicker[] = [];
    for (const s of filtered) {
      if (pinnedSet.has(s.id)) pinned.push(s);
      else if (recentSet.has(s.id)) recent.push(s);
      else rest.push(s);
    }
    // Order recent group by MRU position.
    const recentOrder = new Map(recentIds.map((id, i) => [id, i] as const));
    recent.sort(
      (a, b) =>
        (recentOrder.get(a.id) ?? Infinity) -
        (recentOrder.get(b.id) ?? Infinity),
    );
    return { pinned, recent, rest };
  }, [filtered, pinnedSet, recentSet, recentIds]);

  function toggleSelect(id: number) {
    if (selectedSet.has(id)) {
      onChange(value.filter((x) => x !== id));
    } else {
      onChange([...value, id]);
      pushRecent(id);
    }
  }

  function handleClear() {
    onChange([]);
  }

  const selectedCount = value.length;
  const noOptionsAtAll = !isLoading && segments.length === 0;
  const triggerDisabled = disabled || isLoading || noOptionsAtAll;

  // Selected chips below the trigger.
  const chipSegments = React.useMemo(() => {
    const byId = new Map(segments.map((s) => [s.id, s] as const));
    return value
      .map((id) => byId.get(id))
      .filter((s): s is SegmentForPicker => s !== undefined);
  }, [segments, value]);

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
                  ? "No segments available."
                  : selectedCount === 0
                    ? "Select segments"
                    : `${selectedCount} segment${selectedCount === 1 ? "" : "s"} selected`}
            </span>
            {isLoading ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <ChevronDown className="size-4 opacity-60" aria-hidden />
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
              minWidth: "20rem",
            }}
          >
            {/* Filter tabs */}
            <div className="flex flex-wrap items-center gap-1 border-b p-2">
              {FILTER_TABS.map((t) => {
                const active = tab === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTab(t.key)}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-xs transition-colors",
                      active
                        ? "border-foreground bg-foreground text-background"
                        : "border-border bg-background text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>

            {/* Search */}
            <div className="border-b p-2">
              <div className="relative">
                <Search
                  className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search segments…"
                  className="h-8 pl-7 text-sm"
                  autoFocus
                />
              </div>
              <div className="flex items-center justify-between pt-2 text-xs">
                <span className="text-muted-foreground">
                  {filtered.length} match
                  {filtered.length === 1 ? "" : "es"}
                </span>
                <button
                  type="button"
                  onClick={handleClear}
                  className="text-muted-foreground hover:text-foreground"
                  disabled={value.length === 0}
                >
                  Clear selection
                </button>
              </div>
            </div>

            {/* Grouped list */}
            <div
              className="max-h-[320px] overflow-y-auto py-1"
              role="listbox"
              aria-multiselectable
            >
              {filtered.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No segments match.
                </p>
              ) : (
                <>
                  <Group
                    title="Pinned"
                    items={groups.pinned}
                    selectedSet={selectedSet}
                    pinnedSet={pinnedSet}
                    onToggleSelect={toggleSelect}
                    onTogglePin={togglePin}
                  />
                  <Group
                    title="Recent"
                    items={groups.recent}
                    selectedSet={selectedSet}
                    pinnedSet={pinnedSet}
                    onToggleSelect={toggleSelect}
                    onTogglePin={togglePin}
                  />
                  <Group
                    title={
                      groups.pinned.length > 0 || groups.recent.length > 0
                        ? "All segments"
                        : null
                    }
                    items={groups.rest}
                    selectedSet={selectedSet}
                    pinnedSet={pinnedSet}
                    onToggleSelect={toggleSelect}
                    onTogglePin={togglePin}
                  />
                </>
              )}
            </div>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>

      {chipSegments.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {chipSegments.map((s) => (
            <span
              key={s.id}
              className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-xs"
            >
              <span className="max-w-[12rem] truncate">{s.name}</span>
              <button
                type="button"
                aria-label={`Remove ${s.name}`}
                disabled={disabled || isLoading}
                onClick={() => toggleSelect(s.id)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Group({
  title,
  items,
  selectedSet,
  pinnedSet,
  onToggleSelect,
  onTogglePin,
}: {
  title: string | null;
  items: SegmentForPicker[];
  selectedSet: Set<number>;
  pinnedSet: Set<number>;
  onToggleSelect: (id: number) => void;
  onTogglePin: (id: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      {title ? (
        <div className="sticky top-0 bg-popover px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </div>
      ) : null}
      {items.map((s) => {
        const checked = selectedSet.has(s.id);
        const pinned = pinnedSet.has(s.id);
        const hasRules = (s.active_rules_count ?? 0) > 0;
        const isAuto = isAutoNamedSegment(s.name);
        const tooltipParts: string[] = [];
        tooltipParts.push(
          `${s.stats.total_count.toLocaleString()} contact${s.stats.total_count === 1 ? "" : "s"}`,
        );
        if (hasRules) {
          tooltipParts.push(
            `${s.active_rules_count} active rule${s.active_rules_count === 1 ? "" : "s"}`,
          );
        }
        if (isAuto) tooltipParts.push("auto-named (rename for clarity)");
        return (
          <div
            key={s.id}
            role="option"
            aria-selected={checked}
            className="flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-accent"
            title={tooltipParts.join(" · ")}
          >
            <button
              type="button"
              onClick={() => onTogglePin(s.id)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={pinned ? `Unpin ${s.name}` : `Pin ${s.name}`}
            >
              {pinned ? (
                <Star
                  className="size-3.5 fill-current text-amber-500"
                  aria-hidden
                />
              ) : (
                <StarOff className="size-3.5" aria-hidden />
              )}
            </button>
            <button
              type="button"
              onClick={() => onToggleSelect(s.id)}
              className="flex flex-1 items-center gap-2 text-left"
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
              <span
                className={cn(
                  "flex-1 truncate",
                  isAuto && "text-muted-foreground italic",
                )}
              >
                {s.name}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {s.segment_id}
              </span>
              {hasRules ? (
                <span
                  className="shrink-0 rounded-full border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-violet-700 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-200"
                  aria-label="Segment has audience rules"
                >
                  Rules
                </span>
              ) : null}
              {isAuto ? (
                <span
                  className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
                  aria-label="Auto-generated name"
                >
                  Auto
                </span>
              ) : null}
              <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                {s.stats.total_count.toLocaleString()}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
