"use client";

import { useState } from "react";

import { MultiSelectPicker } from "@/components/multi-select-picker";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FUNNEL_STAGE_VALUES,
  QUALITY_VALUES,
  SEQUENCE_PLACEMENT_VALUES,
  type CreativeFunnelStage,
  type CreativeQuality,
  type CreativeSequencePlacement,
} from "@/lib/validators/creatives";

export interface BulkEditPayload {
  quality?: CreativeQuality;
  sequence_placement?: CreativeSequencePlacement;
  funnel_stage?: CreativeFunnelStage;
  status?: "active" | "archived";
  add_offer_ids?: number[];
}

export interface BulkEditOfferOption {
  id: number;
  name: string;
  color: string | null;
}

export interface BulkEditFormProps {
  selectedCount: number;
  offers: BulkEditOfferOption[];
  // Which actions the current user may perform — fields are hidden when the
  // permission is absent so the dialog never offers a no-op.
  canEditMeta: boolean;
  canArchive: boolean;
  canRestore: boolean;
  onSubmit: (payload: BulkEditPayload) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

// Sentinel for "leave this field as-is". A real enum value means "apply".
const UNCHANGED = "__unchanged__";

const QUALITY_LABEL: Record<CreativeQuality, string> = {
  high: "High",
  average: "Average",
  poor: "Poor",
  unknown: "Unknown",
};

const SEQUENCE_LABEL: Record<CreativeSequencePlacement, string> = {
  warmup: "WarmUp",
  "1st": "1st",
  "2nd": "2nd",
  "3rd": "3rd",
  "4th": "4th",
  "5th": "5th",
  "6th": "6th",
  any: "Any",
  unknown: "Unknown",
};

const FUNNEL_STAGE_LABEL: Record<CreativeFunnelStage, string> = {
  start: "Start",
  clicked: "Clicked",
  checkout: "Checkout",
  ignored: "Ignored",
  unknown: "Unknown",
};

export function BulkEditForm({
  selectedCount,
  offers,
  canEditMeta,
  canArchive,
  canRestore,
  onSubmit,
  onCancel,
  isSubmitting,
}: BulkEditFormProps) {
  const [quality, setQuality] = useState<string>(UNCHANGED);
  const [sequence, setSequence] = useState<string>(UNCHANGED);
  const [funnelStage, setFunnelStage] = useState<string>(UNCHANGED);
  const [status, setStatus] = useState<string>(UNCHANGED);
  const [addOfferIds, setAddOfferIds] = useState<number[]>([]);

  // Status options depend on permissions: only offer Active (restore) /
  // Archived (archive) when the user can perform that transition.
  const canChangeStatus = canArchive || canRestore;

  const payload: BulkEditPayload = {};
  if (canEditMeta && quality !== UNCHANGED)
    payload.quality = quality as CreativeQuality;
  if (canEditMeta && sequence !== UNCHANGED)
    payload.sequence_placement = sequence as CreativeSequencePlacement;
  if (canEditMeta && funnelStage !== UNCHANGED)
    payload.funnel_stage = funnelStage as CreativeFunnelStage;
  if (canChangeStatus && status !== UNCHANGED)
    payload.status = status as "active" | "archived";
  if (canEditMeta && addOfferIds.length > 0) payload.add_offer_ids = addOfferIds;

  const hasChanges = Object.keys(payload).length > 0;

  const offerOptions = offers.map((o) => ({
    id: o.id,
    label: o.name,
    color: o.color,
  }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!hasChanges || isSubmitting) return;
    await onSubmit(payload);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Changes apply to{" "}
        <span className="font-medium text-foreground">{selectedCount}</span>{" "}
        selected creative{selectedCount === 1 ? "" : "s"}. Leave a field on
        &ldquo;No change&rdquo; to skip it.
      </p>

      {canEditMeta ? (
        <div className="grid gap-2">
          <Label htmlFor="bulk-quality">Quality</Label>
          <Select value={quality} onValueChange={setQuality}>
            <SelectTrigger id="bulk-quality">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNCHANGED}>No change</SelectItem>
              {QUALITY_VALUES.map((q) => (
                <SelectItem key={q} value={q}>
                  {QUALITY_LABEL[q]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {canEditMeta ? (
        <div className="grid gap-2">
          <Label htmlFor="bulk-sequence">Sequence</Label>
          <Select value={sequence} onValueChange={setSequence}>
            <SelectTrigger id="bulk-sequence">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNCHANGED}>No change</SelectItem>
              {SEQUENCE_PLACEMENT_VALUES.map((s) => (
                <SelectItem key={s} value={s}>
                  {SEQUENCE_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {canEditMeta ? (
        <div className="grid gap-2">
          <Label htmlFor="bulk-funnel-stage">Funnel Stage</Label>
          <Select value={funnelStage} onValueChange={setFunnelStage}>
            <SelectTrigger id="bulk-funnel-stage">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNCHANGED}>No change</SelectItem>
              {FUNNEL_STAGE_VALUES.map((s) => (
                <SelectItem key={s} value={s}>
                  {FUNNEL_STAGE_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {canChangeStatus ? (
        <div className="grid gap-2">
          <Label htmlFor="bulk-status">Status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger id="bulk-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNCHANGED}>No change</SelectItem>
              {canRestore ? (
                <SelectItem value="active">Active</SelectItem>
              ) : null}
              {canArchive ? (
                <SelectItem value="archived">Archived</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {canEditMeta ? (
        <div className="grid gap-2">
          <Label>Add to offers</Label>
          <MultiSelectPicker
            options={offerOptions}
            value={addOfferIds}
            onChange={(next) => setAddOfferIds(next.map((v) => Number(v)))}
            placeholder="Select offers to add…"
            searchPlaceholder="Search offers…"
            emptyMessage="No active offers."
            selectedLabel={(n) => `${n} offer${n === 1 ? "" : "s"} to add`}
          />
          <p className="text-xs text-muted-foreground">
            Selected offers are added to each creative&apos;s existing offers.
            Nothing is removed.
          </p>
        </div>
      ) : null}

      <div className="flex justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={!hasChanges || isSubmitting}>
          {isSubmitting ? "Applying…" : "Apply changes"}
        </Button>
      </div>
    </form>
  );
}
