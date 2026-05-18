"use client";

import { Plus, X } from "lucide-react";
import { toast } from "sonner";

import {
  buildStageCreateBody,
  StageForm,
  type StageFormValues,
} from "@/components/campaigns/stage-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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

export interface EditableStage {
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
  tracking_id: string | null;
  split_index: number | null;
  split_total: number | null;
}

export interface StageInlineEditorProps {
  campaign: CampaignLite;
  campaignId: number;
  // When set, the editor opens in edit mode for this stage. Null = create
  // mode (the "+ Add stage" trigger).
  stage: EditableStage | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  // Fired after a successful create OR edit save. Parent should refetch.
  onSaved: () => void;
  // Edit-only optional callbacks.
  onImportResults?: () => void;
  onViewImportHistory?: () => void;
}

// =============== Component ===============

export function StageInlineEditor({
  campaign,
  campaignId,
  stage,
  isOpen,
  onOpenChange,
  onSaved,
  onImportResults,
  onViewImportHistory,
}: StageInlineEditorProps) {
  const createApi = useApiCall<{ id: number; stage_number: number }>();
  const updateApi = useApiCall<{ id: number }>();

  const isEdit = stage !== null;
  const isSubmitting = isEdit ? updateApi.isLoading : createApi.isLoading;

  async function handleSubmit(values: StageFormValues) {
    if (isEdit && stage) {
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
    } else {
      const result = await createApi.execute(
        `/api/campaigns/${campaignId}/stages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildStageCreateBody(values)),
        },
      );
      if (!result.ok) {
        toastApiError(result, "Couldn't create stage");
        return;
      }
      toast.success(`Stage ${result.data.stage_number} created`);
    }
    onOpenChange(false);
    onSaved();
  }

  const initialValues: StageFormValues | undefined = stage
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
    : undefined;

  if (!isOpen) {
    return (
      <Button onClick={() => onOpenChange(true)}>
        <Plus className="size-4" aria-hidden /> Add stage
      </Button>
    );
  }

  const headerTitle = isEdit
    ? `Edit stage ${stage!.stage_number}${stage!.label ? ` · ${stage!.label}` : ""}`
    : "New stage";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between border-b py-2">
        <span className="text-sm font-medium">{headerTitle}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onOpenChange(false)}
          aria-label="Close"
          disabled={isSubmitting}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </CardHeader>
      <CardContent className="p-4">
        <StageForm
          key={isEdit ? `stage-${stage!.id}` : "stage-new"}
          mode={isEdit ? "edit" : "create"}
          campaignId={campaignId}
          stageId={isEdit ? stage!.id : undefined}
          trackingId={isEdit ? stage!.tracking_id : null}
          splitIndex={isEdit ? stage!.split_index : null}
          splitTotal={isEdit ? stage!.split_total : null}
          onSplit={() => {
            onOpenChange(false);
            onSaved();
          }}
          campaign={campaign}
          resultsCounters={
            isEdit
              ? {
                  sms_count: stage!.sms_count,
                  delivered_count: stage!.delivered_count,
                  opt_out_count: stage!.opt_out_count,
                  click_count: stage!.click_count,
                  total_cost: stage!.total_cost,
                }
              : undefined
          }
          onImportResults={isEdit ? onImportResults : undefined}
          onViewImportHistory={isEdit ? onViewImportHistory : undefined}
          initialValues={initialValues}
          onSubmit={handleSubmit}
          onCancel={() => onOpenChange(false)}
          isSubmitting={isSubmitting}
        />
      </CardContent>
    </Card>
  );
}

// Backward-compat alias — the old name still works during the transition.
export { StageInlineEditor as StageInlineCreator };
