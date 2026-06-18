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
  link_mode: "manual" | "tracked";
  brand: {
    id: number;
    name: string;
    color: string | null;
    short_domain: string | null;
  } | null;
  offer: {
    id: number;
    name: string;
    color: string | null;
    sales_pages?: { label: string; url: string }[];
    base_url?: string | null;
    postfix?: string | null;
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
  utm_tag_ids: number[] | null;
  stop_text: string;
  include_no_status: boolean;
  include_clickers: boolean;
  exclude_clickers: boolean;
  scheduled_at: string | null;
  // When set on a tracked campaign, the send has fired → the form locks the
  // Scheduled field. NULL keeps it editable (incl. after a missed attempt).
  sent_at: string | null;
  // Set when a scheduled attempt's window closed before it fired (reschedulable).
  schedule_missed_at?: string | null;
  // Approve-Send gate. With a schedule set, sent_at NULL and not missed it means
  // the stage is ARMED (pre-materialized) → the Scheduled field locks until aborted.
  send_approved?: boolean;
  notes: string | null;
  sms_count: number;
  delivered_count: number;
  opt_out_count: number;
  click_count: number;
  scrubbed_count: number;
  bounced_count: number;
  checkout_click_count: number;
  sales_count: number;
  total_cost: string;
  tracking_id: string | null;
  split_index: number | null;
  split_total: number | null;
  // Behavioral lane identity. NULL ⇒ ordinary stage (can be behaviorally split);
  // 0/1/2 ⇒ this stage IS a lane (the split action is hidden in the editor).
  behavioral_tier: number | null;
}

export interface StageInlineEditorProps {
  campaign: CampaignLite;
  campaignId: number;
  // The parent campaign's tracking_id (when brand+offer are set) and the
  // stage_number the next new stage will get — powers the create-mode
  // tracking-ID preview.
  campaignTrackingId?: string | null;
  nextStageNumber?: number;
  // When set, the editor opens in edit mode for this stage. Null = create
  // mode (the "+ Add stage" trigger).
  stage: EditableStage | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  // Fired after a successful create OR edit save. Parent should refetch.
  onSaved: () => void;
  // Edit-only optional callbacks.
  onImportResults?: () => void;
  onManualResults?: () => void;
  onViewImportHistory?: () => void;
  // Edit-only: trigger a behavioral split from the editor. The parent runs the
  // confirm + POST (shared with the stages-row action).
  onBehavioralSplit?: () => void;
}

// =============== Component ===============

export function StageInlineEditor({
  campaign,
  campaignId,
  campaignTrackingId,
  nextStageNumber,
  stage,
  isOpen,
  onOpenChange,
  onSaved,
  onImportResults,
  onManualResults,
  onViewImportHistory,
  onBehavioralSplit,
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

  // Edit mode: seed the form from the stage. full_url_auto is intentionally
  // omitted so it defaults to true; the form reconciles once UTM tags load —
  // if the stored full_url matches the generated value it keeps re-deriving,
  // otherwise it treats the URL as hand-customized and preserves it.
  const initialValues: Partial<StageFormValues> | undefined = stage
    ? {
        label: stage.label ?? "",
        creative_id: stage.creative_id,
        sms_provider_id: stage.sms_provider_id,
        provider_phone_id: stage.provider_phone_id,
        sales_page_label: stage.sales_page_label ?? "",
        short_url: stage.short_url ?? "",
        full_url: stage.full_url ?? "",
        utm_tag_ids: stage.utm_tag_ids ?? [],
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
          campaignTrackingId={campaignTrackingId ?? null}
          nextStageNumber={nextStageNumber}
          splitIndex={isEdit ? stage!.split_index : null}
          splitTotal={isEdit ? stage!.split_total : null}
          behavioralTier={isEdit ? stage!.behavioral_tier : null}
          sentAt={isEdit ? stage!.sent_at : null}
          armed={
            isEdit &&
            !!stage!.send_approved &&
            stage!.sent_at == null &&
            stage!.scheduled_at != null &&
            stage!.schedule_missed_at == null
          }
          onSplit={() => {
            onOpenChange(false);
            onSaved();
          }}
          onBehavioralSplit={isEdit ? onBehavioralSplit : undefined}
          campaign={campaign}
          resultsCounters={
            isEdit
              ? {
                  sms_count: stage!.sms_count,
                  delivered_count: stage!.delivered_count,
                  opt_out_count: stage!.opt_out_count,
                  click_count: stage!.click_count,
                  scrubbed_count: stage!.scrubbed_count,
                  bounced_count: stage!.bounced_count,
                  checkout_click_count: stage!.checkout_click_count,
                  sales_count: stage!.sales_count,
                  total_cost: stage!.total_cost,
                }
              : undefined
          }
          onImportResults={isEdit ? onImportResults : undefined}
          onManualResults={isEdit ? onManualResults : undefined}
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
