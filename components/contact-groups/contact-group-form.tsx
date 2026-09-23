"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ColorPicker } from "@/components/color-picker";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import {
  contactGroupCreateSchema,
  type ContactGroupFormValues,
  type LifecycleOverrideKey,
} from "@/lib/validators/contact-groups";

export type { ContactGroupFormValues };

/** The org-level values a blank override inherits, for the "Effective: N" hints. */
export type OrgThresholds = Record<LifecycleOverrideKey, number>;

type PreviewResult = {
  evaluated: number;
  transitions: Record<string, number>;
};

const LIFECYCLE_FIELDS: {
  name: LifecycleOverrideKey;
  label: string;
  min: number;
  max: number;
}[] = [
  { name: "freeze_after_messages", label: "Freeze after messages", min: 1, max: 1000 },
  { name: "freeze_cadence_days", label: "Freeze cadence (days)", min: 1, max: 365 },
  { name: "suppress_after_days", label: "Suppress after (days in freeze)", min: 1, max: 730 },
  { name: "suppress_min_freeze_messages", label: "Suppress after (messages in freeze)", min: 1, max: 100 },
];

export interface ContactGroupFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<ContactGroupFormValues>;
  onSubmit: (values: ContactGroupFormValues) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
  /** Edit mode only: the group being edited, so its override can be previewed. */
  groupId?: number;
  /** Org defaults for the effective-value hints; absent ⇒ the hints read "—". */
  orgThresholds?: OrgThresholds;
  /** Whether this viewer may change the lifecycle overrides (lifecycle.configure). */
  canConfigureLifecycle?: boolean;
}

export function ContactGroupForm({
  mode,
  initialValues,
  onSubmit,
  onCancel,
  isSubmitting,
  groupId,
  orgThresholds,
  canConfigureLifecycle = false,
}: ContactGroupFormProps) {
  const isEdit = mode === "edit";
  const previewApi = useApiCall<PreviewResult>();
  const [groupPreview, setGroupPreview] = useState<PreviewResult | null>(null);

  const form = useForm<ContactGroupFormValues>({
    resolver: zodResolver(contactGroupCreateSchema),
    defaultValues: {
      name: initialValues?.name ?? "",
      contact_group_id: initialValues?.contact_group_id ?? "",
      description: initialValues?.description ?? "",
      color: initialValues?.color ?? "",
      freeze_after_messages: initialValues?.freeze_after_messages ?? null,
      freeze_cadence_days: initialValues?.freeze_cadence_days ?? null,
      suppress_after_days: initialValues?.suppress_after_days ?? null,
      suppress_min_freeze_messages: initialValues?.suppress_min_freeze_messages ?? null,
    },
  });

  async function previewOverrides() {
    if (groupId == null) return;
    const v = form.getValues();
    setGroupPreview(null);
    const r = await previewApi.execute("/api/settings/lifecycle/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        group: {
          group_id: groupId,
          overrides: {
            freeze_after_messages: v.freeze_after_messages ?? null,
            freeze_cadence_days: v.freeze_cadence_days ?? null,
            suppress_after_days: v.suppress_after_days ?? null,
            suppress_min_freeze_messages: v.suppress_min_freeze_messages ?? null,
          },
        },
      }),
    });
    if (r.ok) setGroupPreview(r.data);
    else toastApiError(r, "Could not preview this override");
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="grid gap-4"
        noValidate
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Name</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. High-value customers"
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="contact_group_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Contact Group ID</FormLabel>
              <FormControl>
                <Input
                  placeholder="high-value"
                  disabled={isEdit || isSubmitting}
                  readOnly={isEdit}
                  {...field}
                />
              </FormControl>
              <FormDescription>
                {isEdit
                  ? "Contact Group ID can't be changed after creation."
                  : "Letters, digits, hyphens, and underscores only."}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="What this group represents."
                  rows={3}
                  disabled={isSubmitting}
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormDescription>Max 500 characters.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="color"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Color</FormLabel>
              <FormControl>
                <ColorPicker
                  value={field.value || null}
                  onChange={(c) => field.onChange(c ?? "")}
                  disabled={isSubmitting}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="space-y-3 rounded-md border p-3">
          <div>
            <p className="text-sm font-medium">Lifecycle overrides</p>
            <p className="text-xs text-muted-foreground">
              Leave a field blank to inherit the organization&apos;s value. A contact in
              several groups takes the strictest value across all of them, not necessarily
              this one: the lowest freeze threshold, the longest cadence, and the shortest
              suppression window.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {LIFECYCLE_FIELDS.map((f) => (
              <FormField
                key={f.name}
                control={form.control}
                name={f.name}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{f.label}</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={f.min}
                        max={f.max}
                        placeholder={`Inherit (${orgThresholds?.[f.name] ?? "—"})`}
                        disabled={isSubmitting || !canConfigureLifecycle}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(e.target.value === "" ? null : Number(e.target.value))
                        }
                      />
                    </FormControl>
                    <FormDescription>
                      {field.value == null
                        ? `Effective: ${orgThresholds?.[f.name] ?? "—"} (org default)`
                        : `Effective: ${field.value} (this group)`}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
          </div>
          {isEdit && groupId != null && canConfigureLifecycle ? (
            <div className="space-y-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={previewApi.isLoading || isSubmitting}
                onClick={() => void previewOverrides()}
              >
                {previewApi.isLoading ? (
                  <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                ) : null}
                Preview effect on this group
              </Button>
              {groupPreview ? (
                Object.keys(groupPreview.transitions).length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No contact changes status under these values.
                  </p>
                ) : (
                  <ul className="text-xs text-muted-foreground">
                    {Object.entries(groupPreview.transitions)
                      .sort((a, b) => b[1] - a[1])
                      .map(([move, n]) => (
                        <li key={move}>
                          {move.replace("\u2192", " \u2192 ")} {n.toLocaleString()}
                        </li>
                      ))}
                  </ul>
                )
              ) : null}
            </div>
          ) : null}
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
            {isEdit ? "Save changes" : "Create"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
