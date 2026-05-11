"use client";

import { Check, ChevronDown, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type StatusColor = "green" | "amber" | "red" | "gray" | "orange";

export interface StatusOption<S extends string> {
  value: S;
  label: string;
  color: StatusColor;
  disabled?: boolean;
}

export interface StatusDropdownProps<S extends string> {
  current: S;
  options: StatusOption<S>[];
  onChange: (next: S) => Promise<void>;
  isUpdating?: boolean;
  isTerminal?: boolean;
}

const COLOR_CLASSES: Record<StatusColor, string> = {
  green:
    "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  amber:
    "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  red:
    "border-red-200 bg-red-100 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
  gray:
    "border-slate-200 bg-slate-100 text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200",
  orange:
    "border-orange-200 bg-orange-100 text-orange-800 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-200",
};

const DOT_CLASSES: Record<StatusColor, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  gray: "bg-slate-400",
  orange: "bg-orange-500",
};

export function StatusDropdown<S extends string>({
  current,
  options,
  onChange,
  isUpdating,
  isTerminal,
}: StatusDropdownProps<S>) {
  const currentOpt = options.find((o) => o.value === current);
  const color = currentOpt?.color ?? "gray";
  const label = currentOpt?.label ?? current;

  const badge = (
    <Badge
      className={cn(
        "inline-flex items-center gap-1.5",
        COLOR_CLASSES[color],
      )}
    >
      <span className={cn("size-1.5 rounded-full", DOT_CLASSES[color])} />
      {label}
      {isUpdating ? (
        <Loader2 className="size-3 animate-spin" aria-hidden />
      ) : !isTerminal ? (
        <ChevronDown className="size-3" aria-hidden />
      ) : null}
    </Badge>
  );

  if (isTerminal) {
    return (
      <span className="cursor-default" aria-disabled>
        {badge}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={isUpdating}
        className="cursor-pointer disabled:cursor-default"
        onClick={(e) => e.stopPropagation()}
      >
        {badge}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        {options.map((opt) => {
          const isCurrent = opt.value === current;
          return (
            <DropdownMenuItem
              key={opt.value}
              disabled={opt.disabled || isCurrent}
              onSelect={(e) => {
                e.preventDefault();
                if (!isCurrent && !opt.disabled) {
                  void onChange(opt.value);
                }
              }}
              className="gap-2"
            >
              <span
                className={cn("size-1.5 rounded-full", DOT_CLASSES[opt.color])}
              />
              <span className="flex-1">{opt.label}</span>
              {isCurrent ? <Check className="size-3.5" aria-hidden /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
