"use client";

import { AlertTriangle, Info } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  findGaps,
  minutesToLabel,
  validateWindowSet,
  type StageWindow,
} from "@/lib/drip/windows";

// Drip stage window fields (Drip Phase 5).
//
// Rendered inside StageForm, which is the LIVE stage editor — reached via
// campaigns/[id]/page.tsx -> StageInlineEditor -> StageForm. (CampaignForm /
// CampaignFormFields are dead render code; a control put there would look
// shipped and never appear.)
//
// ⚠️ THE VALIDATION HERE IS THE SAME FUNCTION THE SERVER USES.
// `validateWindowSet` comes from lib/drip/windows.ts, which the save endpoint
// also calls. A second, client-only copy of "windows may not touch" would drift
// from the server's copy, and the operator would meet the real rule only as a
// save failure with different wording.
//
// ⚠️ Overlap/touch BLOCKS. A gap only WARNS — a gap is legal, and leads arriving
// in one simply wait for the next window. But an unintended gap is invisible
// otherwise, which is why it is surfaced at all.

function parseHHMM(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export interface DripStageWindowFieldsProps {
  startMin: number | null;
  endMin: number | null;
  active: boolean;
  disabled?: boolean;
  /** The OTHER active stages on this campaign, for overlap/touch/gap checks. */
  siblings: StageWindow[];
  onChange: (v: { startMin: number | null; endMin: number | null; active: boolean }) => void;
}

export function DripStageWindowFields({
  startMin, endMin, active, disabled, siblings, onChange,
}: DripStageWindowFieldsProps) {
  const mine: StageWindow[] =
    startMin != null && endMin != null
      ? [{ stage_id: -1, window_start_min: startMin, window_end_min: endMin }]
      : [];
  const all = [...siblings, ...mine];
  const problems = validateWindowSet(all);
  const gaps = findGaps(all);

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <Label className="text-sm font-medium">Daily send window (ET)</Label>
          <p className="text-muted-foreground text-xs">
            A drip stage is a time of day, not a date. A lead gets one first-send — from the
            stage whose window covers its arrival, or the next window to open.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="drip-active" className="text-xs">
            Active
          </Label>
          <Switch
            id="drip-active"
            checked={active}
            disabled={disabled}
            onCheckedChange={(v) => onChange({ startMin, endMin, active: v })}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="drip-start" className="text-xs">
            Opens<span aria-hidden className="text-destructive ml-0.5">*</span>
          </Label>
          <Input
            id="drip-start"
            placeholder="09:30"
            defaultValue={startMin == null ? "" : minutesToLabel(startMin)}
            disabled={disabled}
            className="font-mono"
            onBlur={(e) => onChange({ startMin: parseHHMM(e.target.value), endMin, active })}
          />
        </div>
        <div>
          <Label htmlFor="drip-end" className="text-xs">
            Closes<span aria-hidden className="text-destructive ml-0.5">*</span>
          </Label>
          <Input
            id="drip-end"
            placeholder="13:59"
            defaultValue={endMin == null ? "" : minutesToLabel(endMin)}
            disabled={disabled}
            className="font-mono"
            onBlur={(e) => onChange({ startMin, endMin: parseHHMM(e.target.value), active })}
          />
          <p className="text-muted-foreground mt-1 text-xs">
            Exclusive — a lead arriving exactly at this minute belongs to the next window.
          </p>
        </div>
      </div>

      {problems.length > 0 && (
        <ul className="space-y-1">
          {problems.map((p, i) => (
            <li key={i} className="text-destructive flex items-start gap-1.5 text-xs">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{p.message}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Gaps warn but never block. */}
      {problems.length === 0 && gaps.length > 0 && (
        <ul className="space-y-1">
          {gaps.map((g, i) => (
            <li key={i} className="text-muted-foreground flex items-start gap-1.5 text-xs">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{g.message}</span>
            </li>
          ))}
        </ul>
      )}

      {siblings.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground text-xs">Other active windows:</span>
          {siblings.map((s) => (
            <Badge key={s.stage_id} variant="outline" className="font-mono text-[10px]">
              {minutesToLabel(s.window_start_min)}–{minutesToLabel(s.window_end_min)}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
