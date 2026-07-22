"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Check, ChevronDown, Loader2, Search, Star, StarOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePickerPrefs } from "@/lib/hooks/use-picker-prefs";
import { cn } from "@/lib/utils";

// Shape matches campaign-form-state.Offer (only the fields the picker renders).
export interface OfferForPicker {
  id: number;
  name: string;
  color: string | null;
}

export interface OfferPickerProps {
  offers: OfferForPicker[];
  // Single-select: the chosen offer id, or null when none is picked.
  value: number | null;
  onChange: (next: number | null) => void;
  isLoading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

type FilterTab = "all" | "recent" | "pinned";

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "recent", label: "Recent" },
  { key: "pinned", label: "Pinned" },
];

export function OfferPicker({
  offers,
  value,
  onChange,
  isLoading = false,
  disabled = false,
  placeholder = "Select",
  className,
}: OfferPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [tab, setTab] = React.useState<FilterTab>("all");
  const { pinnedIds, recentIds, togglePin, pushRecent } =
    usePickerPrefs("offers");

  React.useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const pinnedSet = React.useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const recentSet = React.useMemo(() => new Set(recentIds), [recentIds]);

  // Filter by search + tab.
  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return offers.filter((o) => {
      if (q && !o.name.toLowerCase().includes(q)) return false;
      if (tab === "recent" && !recentSet.has(o.id)) return false;
      if (tab === "pinned" && !pinnedSet.has(o.id)) return false;
      return true;
    });
  }, [offers, search, tab, recentSet, pinnedSet]);

  // Group: pinned first, then recent (in MRU order), then everything else.
  const groups = React.useMemo(() => {
    const pinned: OfferForPicker[] = [];
    const recent: OfferForPicker[] = [];
    const rest: OfferForPicker[] = [];
    for (const o of filtered) {
      if (pinnedSet.has(o.id)) pinned.push(o);
      else if (recentSet.has(o.id)) recent.push(o);
      else rest.push(o);
    }
    const recentOrder = new Map(recentIds.map((id, i) => [id, i] as const));
    recent.sort(
      (a, b) =>
        (recentOrder.get(a.id) ?? Infinity) -
        (recentOrder.get(b.id) ?? Infinity),
    );
    return { pinned, recent, rest };
  }, [filtered, pinnedSet, recentSet, recentIds]);

  function handleSelect(id: number) {
    onChange(id);
    pushRecent(id);
    setOpen(false);
  }

  const selected = React.useMemo(
    () => offers.find((o) => o.id === value) ?? null,
    [offers, value],
  );
  const noOptionsAtAll = !isLoading && offers.length === 0;
  const triggerDisabled = disabled || isLoading || noOptionsAtAll;

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
              !selected && "text-muted-foreground",
            )}
          >
            <span className="inline-flex min-w-0 items-center gap-2 truncate text-left">
              {selected ? (
                <>
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: selected.color ?? "#64748B" }}
                    aria-hidden
                  />
                  <span className="truncate">{selected.name}</span>
                </>
              ) : isLoading ? (
                "Loading…"
              ) : noOptionsAtAll ? (
                "No offers available."
              ) : (
                placeholder
              )}
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
                  placeholder="Search offers…"
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
                  onClick={() => onChange(null)}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                  disabled={value === null}
                >
                  Clear selection
                </button>
              </div>
            </div>

            {/* Grouped list */}
            <div className="max-h-[320px] overflow-y-auto py-1" role="listbox">
              {filtered.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No offers match.
                </p>
              ) : (
                <>
                  <Group
                    title="Pinned"
                    items={groups.pinned}
                    selectedId={value}
                    pinnedSet={pinnedSet}
                    onSelect={handleSelect}
                    onTogglePin={togglePin}
                  />
                  <Group
                    title="Recent"
                    items={groups.recent}
                    selectedId={value}
                    pinnedSet={pinnedSet}
                    onSelect={handleSelect}
                    onTogglePin={togglePin}
                  />
                  <Group
                    title={
                      groups.pinned.length > 0 || groups.recent.length > 0
                        ? "All offers"
                        : null
                    }
                    items={groups.rest}
                    selectedId={value}
                    pinnedSet={pinnedSet}
                    onSelect={handleSelect}
                    onTogglePin={togglePin}
                  />
                </>
              )}
            </div>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </div>
  );
}

function Group({
  title,
  items,
  selectedId,
  pinnedSet,
  onSelect,
  onTogglePin,
}: {
  title: string | null;
  items: OfferForPicker[];
  selectedId: number | null;
  pinnedSet: Set<number>;
  onSelect: (id: number) => void;
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
      {items.map((o) => {
        const checked = selectedId === o.id;
        const pinned = pinnedSet.has(o.id);
        return (
          <div
            key={o.id}
            role="option"
            aria-selected={checked}
            className="flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-accent"
          >
            <button
              type="button"
              onClick={() => onTogglePin(o.id)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={pinned ? `Unpin ${o.name}` : `Pin ${o.name}`}
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
              onClick={() => onSelect(o.id)}
              className="flex flex-1 items-center gap-2 text-left"
            >
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-full",
                  checked ? "text-foreground" : "text-transparent",
                )}
                aria-hidden
              >
                {checked ? <Check className="size-3.5" /> : null}
              </span>
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: o.color ?? "#64748B" }}
                aria-hidden
              />
              <span className="flex-1 truncate">{o.name}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
