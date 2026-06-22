"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import {
  formatRevenue,
  formatRoi,
  stageRevenue,
  stageRoi,
} from "@/lib/stage-results";

// =============== Types ===============

export interface ManualResultsValues {
  sms_count: number;
  delivered_count: number;
  opt_out_count: number;
  click_count: number;
  scrubbed_count: number;
  bounced_count: number;
  checkout_click_count: number;
  sales_count: number;
  total_cost: string;
  // false ⇒ total_cost is auto-derived (cost_per_sms × (sends + opt-outs));
  // true ⇒ the operator typed an explicit figure.
  total_cost_manual: boolean;
}

export interface ManualResultsFormProps {
  campaignId: number;
  stageId: number;
  initial: ManualResultsValues;
  // The stage's assigned provider-phone cost-per-SMS, used to auto-calculate
  // Total Cost. Null when no phone is assigned ⇒ auto Total Cost is $0 and the
  // operator is nudged to type a value (or assign a phone).
  costPerSms?: number | null;
  // Real messages accepted by the provider (stage_sends status='sent'). For
  // API/tracked stages this — not the operator's sms_count — is the dispatched
  // count, so the auto cost preview uses GREATEST(sms_count, sentCount).
  sentCount?: number;
  // Whether the stage has been sent (sent_at set). Cost only calculates after
  // the send; a hand-entered sms_count > 0 also unlocks it (results = sent).
  isSent?: boolean;
  // Current offer CPA payout, used for a live revenue/ROI preview. The saved
  // value is snapshotted server-side at save time. Null when the campaign has
  // no offer or the offer has no CPA payout.
  offerPayoutCpa?: number | null;
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
  { key: "checkout_click_count", label: "Checkout Clicks" },
  { key: "sales_count", label: "Sales" },
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
  costPerSms,
  sentCount = 0,
  isSent = false,
  offerPayoutCpa,
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
    checkout_click_count: String(initial.checkout_click_count),
    sales_count: String(initial.sales_count),
  }));
  // Normalize the incoming numeric string (e.g. "0.0000") to a friendlier
  // editable form without trailing-zero noise.
  const [totalCost, setTotalCost] = useState<string>(() => {
    const n = Number(initial.total_cost);
    return Number.isFinite(n) && n !== 0 ? String(n) : "";
  });
  // Auto Total Cost is the default; flip to manual to type an explicit figure
  // (e.g. a provider that bills differently from cost-per-SMS).
  const [autoCost, setAutoCost] = useState<boolean>(() => !initial.total_cost_manual);

  // Live auto value: cost_per_sms × (sends + opt-outs). Mirrors the server,
  // including its GREATEST(sms_count, real accepted sends) sends source and the
  // "only after the send" gate: $0 until the stage is sent (sent_at) or results
  // are hand-entered (sms_count > 0).
  const perSms = costPerSms ?? 0;
  const effectiveSends = Math.max(toInt(counts.sms_count), sentCount);
  const costUnlocked = isSent || toInt(counts.sms_count) > 0;
  const autoTotalCost = costUnlocked
    ? perSms * (effectiveSends + toInt(counts.opt_out_count))
    : 0;
  // The cost that drives the save + the revenue/ROI preview.
  const effectiveCost = autoCost ? autoTotalCost : toMoney(totalCost);

  async function handleSave() {
    const body = {
      sms_count: toInt(counts.sms_count),
      delivered_count: toInt(counts.delivered_count),
      opt_out_count: toInt(counts.opt_out_count),
      click_count: toInt(counts.click_count),
      scrubbed_count: toInt(counts.scrubbed_count),
      bounced_count: toInt(counts.bounced_count),
      checkout_click_count: toInt(counts.checkout_click_count),
      sales_count: toInt(counts.sales_count),
      // When auto, the server recomputes from the phone cost and ignores this
      // value; we still send the preview figure for clarity.
      total_cost: effectiveCost,
      total_cost_manual: !autoCost,
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
              // Auto mode shows the live derived figure and locks the field.
              value={autoCost ? autoTotalCost.toFixed(2) : totalCost}
              disabled={saveApi.isLoading || autoCost}
              onChange={(e) => setTotalCost(e.target.value)}
              className="pl-6"
            />
          </div>
        </div>
      </div>

      {/* Auto-calculate toggle. cost_per_sms × (SMS sent + Opt-outs). */}
      <div className="flex items-start justify-between gap-3 rounded-md border bg-muted/30 p-3">
        <div className="grid gap-0.5">
          <Label htmlFor="manual-auto-cost" className="text-sm">
            Auto-calculate total cost
          </Label>
          <p className="text-xs text-muted-foreground">
            {costPerSms == null ? (
              "No phone assigned to this stage — assign one with a cost per SMS, or turn this off to type a cost."
            ) : !costUnlocked ? (
              "Cost calculates after the stage is sent — enter the SMS-sent count (or mark the stage sent) to compute it."
            ) : (
              <>
                ${perSms.toFixed(4)}/SMS × ({effectiveSends.toLocaleString()}{" "}
                sent + {toInt(counts.opt_out_count)} opt-outs) ={" "}
                <span className="font-mono">${autoTotalCost.toFixed(2)}</span>
              </>
            )}
          </p>
        </div>
        <Switch
          id="manual-auto-cost"
          checked={autoCost}
          disabled={saveApi.isLoading}
          onCheckedChange={setAutoCost}
        />
      </div>

      {toInt(counts.sales_count) > 0 ? (
        <RevenuePreview
          sales={toInt(counts.sales_count)}
          payoutEach={offerPayoutCpa ?? null}
          cost={effectiveCost}
        />
      ) : null}

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

// Live revenue/ROI readout shown once a sales count is entered. The payout
// rate is the offer's current CPA; the server snapshots it on save.
function RevenuePreview({
  sales,
  payoutEach,
  cost,
}: {
  sales: number;
  payoutEach: number | null;
  cost: number;
}) {
  const revenue = stageRevenue(sales, payoutEach);
  const roi = stageRoi(revenue, cost);
  return (
    <div className="grid gap-1 rounded-md border bg-muted/30 p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Revenue</span>
        <span className="font-mono tabular-nums">
          {formatRevenue(revenue)}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">ROI</span>
        <span className="font-mono tabular-nums">{formatRoi(roi)}</span>
      </div>
      {payoutEach == null ? (
        <p className="text-xs text-muted-foreground">
          Set this offer&apos;s CPA payout to compute revenue.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {sales.toLocaleString()} × ${payoutEach.toFixed(2)} payout. Saved at
          today&apos;s offer payout.
        </p>
      )}
    </div>
  );
}
