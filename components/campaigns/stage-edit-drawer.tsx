"use client";

import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  buildStageCreateBody,
  StageForm,
  type StageFormValues,
} from "@/components/campaigns/stage-form";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { toastApiError } from "@/lib/api/toast-error";
import { utcToCampaignLocalInput } from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";

// =============== Types ===============

interface CampaignLite {
  id: number;
  name: string;
  brand: { id: number; name: string; color: string | null } | null;
  offer: {
    id: number;
    name: string;
    color: string | null;
    sales_pages?: { label: string; url: string }[];
  } | null;
  audience_snapshot_count: number;
}

export interface StageDrawerStage {
  id: number;
  stage_number: number;
  label: string | null;
  creative_id: number | null;
  sms_provider_id: number | null;
  provider_phone_id: number | null;
  sales_page_label: string | null;
  short_url: string | null;
  full_url: string | null;
  stop_text: string;
  include_no_status: boolean;
  include_clickers: boolean;
  exclude_clickers: boolean;
  scheduled_at: string | null;
  notes: string | null;
  sms_count: number;
  delivered_count: number;
  opt_out_count: number;
  click_count: number;
  total_cost: string;
}

export interface StageEditDrawerProps {
  campaign: CampaignLite;
  campaignId: number;
  stage: StageDrawerStage | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
  onImportResults?: () => void;
  onViewImportHistory?: () => void;
}

// =============== Component ===============

export function StageEditDrawer({
  campaign,
  campaignId,
  stage,
  open,
  onOpenChange,
  onUpdated,
  onImportResults,
  onViewImportHistory,
}: StageEditDrawerProps) {
  const updateApi = useApiCall<{ id: number }>();

  async function handleSubmit(values: StageFormValues) {
    if (!stage) return;
    const result = await updateApi.execute(
      `/api/campaigns/${campaignId}/stages/${stage.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildStageCreateBody(values)),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't save stage");
      return;
    }
    toast.success("Stage saved");
    onOpenChange(false);
    onUpdated();
  }

  const initialValues: StageFormValues | null = stage
    ? {
        label: stage.label ?? "",
        creative_id: stage.creative_id,
        sms_provider_id: stage.sms_provider_id,
        provider_phone_id: stage.provider_phone_id,
        sales_page_label: stage.sales_page_label ?? "",
        short_url: stage.short_url ?? "",
        full_url: stage.full_url ?? "",
        stop_text: stage.stop_text,
        include_no_status: stage.include_no_status,
        include_clickers: stage.include_clickers,
        exclude_clickers: stage.exclude_clickers,
        scheduled_at: utcToCampaignLocalInput(stage.scheduled_at),
        notes: stage.notes ?? "",
      }
    : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex w-full flex-col gap-0 p-0 sm:max-w-[560px]"
      >
        <SheetHeader className="border-b">
          <SheetTitle>
            {stage
              ? `Edit stage ${stage.stage_number}${stage.label ? ` · ${stage.label}` : ""}`
              : "Edit stage"}
          </SheetTitle>
          <SheetDescription>
            Under {campaign.name}.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {stage && initialValues ? (
            <StageForm
              key={`drawer-stage-${stage.id}`}
              mode="edit"
              campaignId={campaignId}
              stageId={stage.id}
              campaign={campaign}
              resultsCounters={{
                sms_count: stage.sms_count,
                delivered_count: stage.delivered_count,
                opt_out_count: stage.opt_out_count,
                click_count: stage.click_count,
                total_cost: stage.total_cost,
              }}
              onImportResults={onImportResults}
              onViewImportHistory={onViewImportHistory}
              initialValues={initialValues}
              onSubmit={handleSubmit}
              onCancel={() => onOpenChange(false)}
              isSubmitting={updateApi.isLoading}
              renderActions={({ onSave, onCancel, isSubmitting }) => (
                <div className="sticky bottom-0 -mx-4 -mb-4 mt-4 flex items-center justify-end gap-2 border-t bg-background px-4 py-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onCancel}
                    disabled={isSubmitting}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={onSave}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : null}
                    Save changes
                  </Button>
                </div>
              )}
            />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
