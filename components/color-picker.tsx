"use client";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const PRESETS = [
  "#EF4444",
  "#F59E0B",
  "#10B981",
  "#3B82F6",
  "#6366F1",
  "#A855F7",
  "#EC4899",
  "#0EA5E9",
  "#F97316",
  "#84CC16",
  "#06B6D4",
  "#64748B",
];

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

export interface ColorPickerProps {
  value: string | null | undefined;
  onChange: (color: string | null) => void;
  disabled?: boolean;
}

export function ColorPicker({ value, onChange, disabled }: ColorPickerProps) {
  const current = value ?? "";
  const isPreset = !!current && PRESETS.includes(current.toUpperCase());

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((c) => {
          const active = current.toUpperCase() === c;
          return (
            <button
              key={c}
              type="button"
              aria-label={c}
              aria-pressed={active}
              disabled={disabled}
              onClick={() => onChange(c)}
              style={{ backgroundColor: c }}
              className={cn(
                "size-6 rounded-full border transition-shadow",
                active && "ring-2 ring-ring ring-offset-2 ring-offset-background",
                !disabled && "hover:scale-105",
                disabled && "cursor-not-allowed opacity-60",
              )}
            />
          );
        })}
      </div>
      <Input
        type="text"
        value={current}
        onChange={(e) => {
          const v = e.target.value.trim();
          if (v === "") {
            onChange(null);
            return;
          }
          onChange(v);
        }}
        placeholder="#RRGGBB"
        disabled={disabled}
        className={cn(
          "h-8 w-[100px] font-mono text-xs",
          current && !HEX_RE.test(current) && "border-destructive",
          current && !isPreset && HEX_RE.test(current) && "ring-2 ring-ring",
        )}
      />
    </div>
  );
}
