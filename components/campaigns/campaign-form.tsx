"use client";

import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";

import { CampaignFormFields } from "./campaign-form-fields";
import {
  useCampaignFormState,
  type CampaignFormProps,
} from "./campaign-form-state";

// Re-export public types so existing imports stay valid.
export type {
  AudienceFilters,
  CampaignFormValues,
  CampaignFormProps,
} from "./campaign-form-state";

export function CampaignForm(props: CampaignFormProps) {
  const state = useCampaignFormState(props);
  const {
    form,
    isEdit,
    activateReady,
    draftReady,
    activateBlockedReason,
    anySubmitting,
    isSubmittingDraft,
    isSubmittingActivate,
    handleDraftClick,
    handleActivateClick,
  } = state;

  return (
    <Form {...form}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          // Default submit (Enter key) runs the primary action.
          if (isEdit) void handleActivateClick();
          else if (activateReady) void handleActivateClick();
          else if (draftReady) void handleDraftClick();
        }}
        className="grid gap-6"
        noValidate
      >
        <CampaignFormFields state={state} />

        {/* ============ Actions ============ */}
        <div className="grid gap-2 pt-2">
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={props.onCancel}
              disabled={anySubmitting}
            >
              Cancel
            </Button>
            {isEdit ? (
              <Button
                type="button"
                onClick={handleActivateClick}
                disabled={anySubmitting}
              >
                {isSubmittingActivate ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : null}
                Save changes
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleDraftClick}
                  disabled={!draftReady || anySubmitting}
                >
                  {isSubmittingDraft ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : null}
                  Save as draft
                </Button>
                <Button
                  type="button"
                  onClick={handleActivateClick}
                  disabled={!activateReady || anySubmitting}
                  title={activateBlockedReason ?? undefined}
                >
                  {isSubmittingActivate ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : null}
                  Activate
                </Button>
              </>
            )}
          </div>
          {!isEdit ? (
            <p className="text-right text-xs text-muted-foreground">
              Draft saves without sending. Activate freezes the audience and
              prepares the campaign for stage management.
            </p>
          ) : null}
        </div>
      </form>
    </Form>
  );
}
