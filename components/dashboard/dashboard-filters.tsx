"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  DASHBOARD_PRESETS,
  DASHBOARD_PRESET_LABELS,
  MAX_CUSTOM_RANGE_DAYS,
  type DashboardPreset,
} from "@/lib/dashboard-range";

export type DashboardFilterState = {
  preset: DashboardPreset;
  customFrom: string; // YYYY-MM-DD
  customTo: string; // YYYY-MM-DD
  compare: boolean;
};

export function DashboardFilters({
  value,
  onChange,
  rangeLabel,
}: {
  value: DashboardFilterState;
  onChange: (next: Partial<DashboardFilterState>) => void;
  rangeLabel?: string | null;
}) {
  const isCustom = value.preset === "custom";

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border bg-card p-3">
      <div className="grid gap-1">
        <Label className="text-xs text-muted-foreground">Period</Label>
        <Select
          value={value.preset}
          onValueChange={(v) => onChange({ preset: v as DashboardPreset })}
        >
          <SelectTrigger className="w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DASHBOARD_PRESETS.map((p) => (
              <SelectItem key={p} value={p}>
                {DASHBOARD_PRESET_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isCustom ? (
        <>
          <div className="grid gap-1">
            <Label className="text-xs text-muted-foreground">From</Label>
            <Input
              type="date"
              className="w-[150px]"
              value={value.customFrom}
              max={value.customTo || undefined}
              onChange={(e) => onChange({ customFrom: e.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <Label className="text-xs text-muted-foreground">To</Label>
            <Input
              type="date"
              className="w-[150px]"
              value={value.customTo}
              min={value.customFrom || undefined}
              onChange={(e) => onChange({ customTo: e.target.value })}
            />
          </div>
          <p className="text-xs text-muted-foreground pb-2">
            Up to {MAX_CUSTOM_RANGE_DAYS} days (3 months).
          </p>
        </>
      ) : rangeLabel ? (
        <div className="grid gap-1">
          <Label className="text-xs text-muted-foreground">Showing</Label>
          <span className="text-sm font-medium tabular-nums leading-9">
            {rangeLabel}
          </span>
        </div>
      ) : null}

      <div className="ml-auto flex items-center gap-2 pb-2">
        <Switch
          id="dash-compare"
          checked={value.compare}
          onCheckedChange={(checked) => onChange({ compare: checked })}
        />
        <Label htmlFor="dash-compare" className="text-sm">
          Compare to previous period
        </Label>
      </div>
    </div>
  );
}
