"use client";

import { useState } from "react";
import { CornerDownRight, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api/toast-error";
import {
  formatMinutes,
  TIER_LABEL,
  TIER_OPTIONS,
  type FollowupTier,
} from "@/lib/drip/followup-timing";
import { useApiCall } from "@/lib/hooks/use-api-call";

// Behavioural follow-up children, shown ATTACHED to their parent stage
// (Drip Phase 6).
//
// ⚠️ ATTACHED, NOT LISTED SEPARATELY. A child only means anything relative to
// its parent — it fires off that parent's first-send, to the contacts that
// parent messaged. Listing the three lanes as ordinary rows in the stage table
// would put them beside stages they have nothing to do with, and an operator
// reordering stages would have no way to see what moved with what.
//
// ⚠️ THE TIMER OPTIONS COME FROM lib/drip/followup-timing.ts, the same module
// the scheduler computes due-times with. A hardcoded list here could offer a
// value the scheduler treats differently.

export interface FollowupChild {
  id: number;
  behavioral_tier: number | null;
  drip_followup_minutes: number | null;
  drip_active: boolean | null;
  creative_id: number | null;
  creative_text?: string | null;
}

export function DripFollowupChildren({
  campaignId,
  parentStageId,
  items,
  canEdit,
  onChanged,
}: {
  campaignId: number;
  parentStageId: number;
  items: FollowupChild[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const api = useApiCall<unknown>();
  const [busy, setBusy] = useState<number | null>(null);

  if (items.length === 0) return null;

  async function patch(childId: number, body: Record<string, unknown>) {
    setBusy(childId);
    const r = await api.execute(`/api/campaigns/${campaignId}/stages/${childId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(null);
    if (!r.ok) {
      toastApiError(r, "Couldn't update the follow-up");
      return;
    }
    toast.success("Follow-up updated");
    onChanged();
  }

  const ordered = [...items].sort(
    (a, b) => (a.behavioral_tier ?? 0) - (b.behavioral_tier ?? 0),
  );

  return (
    <div className="ml-6 grid gap-2 border-l pl-4">
      <p className="text-muted-foreground text-xs">
        Behavioural follow-ups for stage {parentStageId}. Each timer runs from
        when the signal was <strong>detected</strong>, not when it happened.
      </p>
      {ordered.map((c) => {
        const tier = (c.behavioral_tier ?? 0) as FollowupTier;
        const options = TIER_OPTIONS[tier];
        const isBusy = busy === c.id;
        return (
          <div
            key={c.id}
            className="grid min-w-0 items-center gap-2 rounded-md border p-2 sm:grid-cols-[auto_1fr_auto_auto]"
          >
            <CornerDownRight className="size-3.5 text-muted-foreground" aria-hidden />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px]">
                  {TIER_LABEL[tier]}
                </Badge>
                {!c.creative_id && (
                  <span className="text-destructive text-xs">needs a creative</span>
                )}
              </div>
              <p className="text-muted-foreground truncate text-xs">
                {c.creative_text ?? "No creative chosen — this lane cannot send."}
              </p>
            </div>

            <div className="min-w-0">
              <Label htmlFor={`t-${c.id}`} className="sr-only">
                {TIER_LABEL[tier]} timer
              </Label>
              <Select
                value={c.drip_followup_minutes ? String(c.drip_followup_minutes) : ""}
                disabled={!canEdit || isBusy}
                onValueChange={(v) => patch(c.id, { drip_followup_minutes: Number(v) })}
              >
                <SelectTrigger id={`t-${c.id}`} className="w-full sm:w-28">
                  <SelectValue placeholder="timer" />
                </SelectTrigger>
                <SelectContent>
                  {options.map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {formatMinutes(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              {isBusy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              {/* ⚠️ Toggle, never delete (spec). Switching a lane off keeps its
                  copy and timer so turning it back on restores the configuration
                  rather than presenting a blank lane. */}
              <Switch
                checked={c.drip_active === true}
                disabled={!canEdit || isBusy || !c.creative_id}
                onCheckedChange={(on) => patch(c.id, { drip_active: on })}
                aria-label={`${TIER_LABEL[tier]} follow-up on`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
