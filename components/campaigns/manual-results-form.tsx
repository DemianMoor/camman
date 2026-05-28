"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";

// =============== Types ===============

export interface ManualResultsValues {
  sms_count: number;
  delivered_count: number;
  opt_out_count: number;
  click_count: number;
  scrubbed_count: number;
  bounced_count: number;
  total_cost: string;
}

export interface ManualResultsFormProps {
  campaignId: number;
  stageId: number;
  initial: ManualResultsValues;
  onClose: () => void;
  onComplete: () => void;
}

// The integer counter fields, in display order. total_cost is handled
// separately because it's a currency input.
const COUNT_FIELDS: {
  key: keyof Omit<ManualResultsValues, "total_cost">;
  label: string;
}[] = [
  { key: "sms_count", label: "SMS sent" },
  { key: "delivered_count", label: "Delivered" },
  { key: "opt_out_count", label: "Opt-outs" },
  { key: "click_count", label: "Clickers" },
  { key: "scrubbed_count", label: "Scrubbed" },
  { key: "bounced_count", label: "Bounced" },
];

// Empty string → 0; otherwise the parsed integer (NaN guarded to 0).
function toInt(v: string): number {
  if (v.trim() === "") return 0;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function toMoney(v: string): number {
  if (v.trim() === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// =============== Component ===============

export function ManualResultsForm({
  campaignId,
  stageId,
  initial,
  onClose,
  onComplete,
}: ManualResultsFormProps) {
  const saveApi = useApiCall<unknown>();
  // Inputs are edited as strings so typing stays smooth; parsed on save.
  const [counts, setCounts] = useState<Record<string, string>>(() => ({
    sms_count: String(initial.sms_count),
    delivered_count: String(initial.delivered_count),
    opt_out_count: String(initial.opt_out_count),
    click_count: String(initial.click_count),
    scrubbed_count: String(initial.scrubbed_count),
    bounced_count: String(initial.bounced_count),
  }));
  // Normalize the incoming numeric string (e.g. "0.0000") to a friendlier
  // editable form without trailing-zero noise.
  const [totalCost, setTotalCost] = useState<string>(() => {
    const n = Number(initial.total_cost);
    return Number.isFinite(n) && n !== 0 ? String(n) : "";
  });

  async function handleSave() {
    const body = {
      sms_count: toInt(counts.sms_count),
      delivered_count: toInt(counts.delivered_count),
      opt_out_count: toInt(counts.opt_out_count),
      click_count: toInt(counts.click_count),
      scrubbed_count: toInt(counts.scrubbed_count),
      bounced_count: toInt(counts.bounced_count),
      total_cost: toMoney(totalCost),
    };
    const r = await saveApi.execute(
      `/api/campaigns/${campaignId}/stages/${stageId}/manual-results`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!r.ok) {
      toastApiError(r, "Couldn't save results");
      return;
    }
    toast.success("Results saved");
    onComplete();
    onClose();
  }

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        Enter the result totals by hand. These values overwrite the stage&apos;s
        current numbers — use this for providers that don&apos;t give you a
        report to import.
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {COUNT_FIELDS.map(({ key, label }) => (
          <div key={key} className="grid gap-1.5">
            <Label htmlFor={`manual-${key}`} className="text-xs">
              {label}
            </Label>
            <Input
              id={`manual-${key}`}
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={counts[key]}
              disabled={saveApi.isLoading}
              onChange={(e) =>
                setCounts((prev) => ({ ...prev, [key]: e.target.value }))
              }
            />
          </div>
        ))}

        <div className="grid gap-1.5">
          <Label htmlFor="manual-total-cost" className="text-xs">
            Total cost (USD)
          </Label>
          <div className="relative">
            <span
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
            >
              $
            </span>
            <Input
              id="manual-total-cost"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              placeholder="0.00"
              value={totalCost}
              disabled={saveApi.isLoading}
              onChange={(e) => setTotalCost(e.target.value)}
              className="pl-6"
            />
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={saveApi.isLoading}
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={saveApi.isLoading}
        >
          {saveApi.isLoading ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : null}
          Save results
        </Button>
      </div>
    </div>
  );
}
