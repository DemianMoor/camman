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
import { useApiCall } from "@/lib/hooks/use-api-call";

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

export interface StageInlineCreatorProps {
  campaign: CampaignLite;
  campaignId: number;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

export function StageInlineCreator({
  campaign,
  campaignId,
  isOpen,
  onOpenChange,
  onCreated,
}: StageInlineCreatorProps) {
  const createApi = useApiCall<{ id: number; stage_number: number }>();

  async function handleSubmit(values: StageFormValues) {
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
    onOpenChange(false);
    onCreated();
  }

  if (!isOpen) {
    return (
      <Button onClick={() => onOpenChange(true)}>
        <Plus className="size-4" aria-hidden /> Add stage
      </Button>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between border-b py-2">
        <span className="text-sm font-medium">New stage</span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onOpenChange(false)}
          aria-label="Close"
          disabled={createApi.isLoading}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </CardHeader>
      <CardContent className="p-4">
        <StageForm
          mode="create"
          campaignId={campaignId}
          campaign={campaign}
          onSubmit={handleSubmit}
          onCancel={() => onOpenChange(false)}
          isSubmitting={createApi.isLoading}
        />
      </CardContent>
    </Card>
  );
}
