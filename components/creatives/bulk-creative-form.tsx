"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { MultiSelectPicker } from "@/components/multi-select-picker";
import { SpamCheckStrip } from "@/components/spam/spam-check-strip";
import { calculateSmsSegments } from "@/lib/creative-helpers";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { cn } from "@/lib/utils";
import {
  BULK_CREATE_MAX,
  QUALITY_VALUES,
  SEQUENCE_PLACEMENT_VALUES,
  type CreativeQuality,
  type CreativeSequencePlacement,
} from "@/lib/validators/creatives";

import type { OfferInfo } from "./creative-form";

const TEXT_WARN_THRESHOLD = 110;

type Row = {
  id: number; // local-only stable key for React
  text: string;
};

export interface BulkCreativeFormSubmit {
  applies_to_all_offers: boolean;
  offer_ids: number[];
  quality: CreativeQuality;
  sequence_placement: CreativeSequencePlacement;
  creatives: Array<{ text: string }>;
}

export interface BulkCreativeFormProps {
  onSubmit: (values: BulkCreativeFormSubmit) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

const QUALITY_LABEL: Record<CreativeQuality, string> = {
  high: "High",
  average: "Average",
  poor: "Poor",
  unknown: "Unknown",
};
const SEQUENCE_LABEL: Record<CreativeSequencePlacement, string> = {
  "1st": "1st",
  "2nd": "2nd",
  "3rd": "3rd",
  any: "Any",
  unknown: "Unknown",
};

let nextRowId = 1;
function newRow(): Row {
  return { id: nextRowId++, text: "" };
}

// Bulk-create dialog. Shared offer/quality/sequence at the top; the row
// list grows up to BULK_CREATE_MAX. Each row enforces non-empty text;
// shared section enforces the at-least-one-offer rule. Server-side the
// whole batch goes through in one transaction.
export function BulkCreativeForm({
  onSubmit,
  onCancel,
  isSubmitting,
}: BulkCreativeFormProps) {
  const offersApi = useApiCall<{ data: OfferInfo[] }>();
  const [offers, setOffers] = useState<OfferInfo[]>([]);

  const [appliesToAll, setAppliesToAll] = useState(false);
  const [offerIds, setOfferIds] = useState<number[]>([]);
  const [quality, setQuality] = useState<CreativeQuality>("unknown");
  const [sequence, setSequence] =
    useState<CreativeSequencePlacement>("unknown");
  const [rows, setRows] = useState<Row[]>(() => [newRow()]);
  const [sharedError, setSharedError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});

  useEffect(() => {
    (async () => {
      const r = await offersApi.execute("/api/offers/list?pageSize=200");
      if (r.ok) setOffers(r.data.data.filter((o) => o.status === "active"));
    })();
  }, [offersApi.execute]);

  function addRow() {
    if (rows.length >= BULK_CREATE_MAX) return;
    setRows((prev) => [...prev, newRow()]);
  }

  function removeRow(id: number) {
    if (rows.length === 1) return;
    setRows((prev) => prev.filter((r) => r.id !== id));
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function updateRow(id: number, text: string) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, text } : r)));
    setRowErrors((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  const counts = useMemo(
    () =>
      rows.map((r) => ({
        id: r.id,
        characters: r.text.length,
        long: r.text.length > TEXT_WARN_THRESHOLD,
        segments: calculateSmsSegments(r.text).segments,
      })),
    [rows],
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSharedError(null);
    const nextRowErrors: Record<number, string> = {};
    for (const row of rows) {
      if (!row.text.trim()) {
        nextRowErrors[row.id] = "Message text is required";
      }
    }
    if (!appliesToAll && offerIds.length === 0) {
      setSharedError(
        "Must apply to at least one offer (or select 'All offers').",
      );
    }
    setRowErrors(nextRowErrors);
    if (
      Object.keys(nextRowErrors).length > 0 ||
      (!appliesToAll && offerIds.length === 0)
    )
      return;

    await onSubmit({
      applies_to_all_offers: appliesToAll,
      offer_ids: appliesToAll ? offerIds : offerIds,
      quality,
      sequence_placement: sequence,
      creatives: rows.map((r) => ({ text: r.text })),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4" noValidate>
      {/* ============ Shared section ============ */}
      <Card>
        <CardContent className="grid gap-4 pt-6">
          <p className="text-xs text-muted-foreground">
            These settings apply to all creatives in this batch.
          </p>

          <div className="flex items-center justify-between gap-3">
            <div>
              <Label className="cursor-pointer" htmlFor="bulk-applies-to-all">
                Apply to all offers
              </Label>
            </div>
            <Switch
              id="bulk-applies-to-all"
              checked={appliesToAll}
              onCheckedChange={(v) => {
                setAppliesToAll(v);
                setSharedError(null);
              }}
              disabled={isSubmitting}
            />
          </div>

          <div className="grid gap-1.5">
            <Label className={appliesToAll ? "opacity-60" : ""}>
              Offers
              {!appliesToAll ? (
                <span aria-hidden className="text-destructive ml-0.5">*</span>
              ) : null}
            </Label>
            <MultiSelectPicker
              options={offers.map((o) => ({
                id: o.id,
                label: o.name,
                color: o.color,
              }))}
              value={offerIds}
              onChange={(next) => {
                setOfferIds(next as number[]);
                setSharedError(null);
              }}
              placeholder="Select offers…"
              selectedLabel={(n) =>
                `${n} offer${n === 1 ? "" : "s"} selected`
              }
              isLoading={offersApi.isLoading && offers.length === 0}
              disabled={isSubmitting || appliesToAll}
              emptyMessage="No active offers available."
              searchPlaceholder="Search offers…"
            />
            {appliesToAll ? (
              <p className="text-xs text-muted-foreground">
                Disabled — these creatives are org-wide.
              </p>
            ) : null}
            {sharedError ? (
              <p className="text-xs text-destructive">{sharedError}</p>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Quality</Label>
              <Select
                value={quality}
                onValueChange={(v) => setQuality(v as CreativeQuality)}
                disabled={isSubmitting}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUALITY_VALUES.map((q) => (
                    <SelectItem key={q} value={q}>
                      {QUALITY_LABEL[q]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Sequence placement</Label>
              <Select
                value={sequence}
                onValueChange={(v) =>
                  setSequence(v as CreativeSequencePlacement)
                }
                disabled={isSubmitting}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEQUENCE_PLACEMENT_VALUES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {SEQUENCE_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ============ Creative rows ============ */}
      <div className="grid gap-3">
        {rows.map((row, i) => {
          const count = counts[i];
          const err = rowErrors[row.id];
          return (
            <div key={row.id} className="rounded-md border p-3">
              <div className="flex items-center justify-between gap-2 pb-2">
                <span className="text-xs font-medium text-muted-foreground">
                  Creative #{i + 1}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={isSubmitting || rows.length === 1}
                  onClick={() => removeRow(row.id)}
                  title={
                    rows.length === 1 ? "At least one row required" : undefined
                  }
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>
              <Textarea
                rows={3}
                placeholder="Message text"
                value={row.text}
                onChange={(e) => updateRow(row.id, e.target.value)}
                disabled={isSubmitting}
                className={cn(
                  "font-mono text-sm",
                  count?.long &&
                    "border-red-400 focus-visible:ring-red-400",
                )}
              />
              <div
                className={cn(
                  "pt-1 text-xs tabular-nums",
                  count?.long
                    ? "text-red-700 dark:text-red-400"
                    : count?.segments > 4
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-muted-foreground",
                )}
              >
                {row.text
                  ? `${count.characters} characters · ${count.segments} segment${count.segments === 1 ? "" : "s"}`
                  : "Empty"}
                {count?.long ? (
                  <span className="ml-2 text-red-700 dark:text-red-400">
                    Over {TEXT_WARN_THRESHOLD} chars — may push past 1 segment
                    once assembled with brand prefix + stop text.
                  </span>
                ) : null}
              </div>
              <SpamCheckStrip
                text={row.text}
                disabled={isSubmitting}
                className="pt-2"
              />
              {err ? (
                <p className="pt-1 text-xs text-destructive">{err}</p>
              ) : null}
            </div>
          );
        })}

        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addRow}
            disabled={isSubmitting || rows.length >= BULK_CREATE_MAX}
          >
            <Plus className="size-4" aria-hidden /> Add another creative
          </Button>
          <span>
            {rows.length} of {BULK_CREATE_MAX} rows
          </span>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : null}
          Save {rows.length} creative{rows.length === 1 ? "" : "s"}
        </Button>
      </div>
    </form>
  );
}
