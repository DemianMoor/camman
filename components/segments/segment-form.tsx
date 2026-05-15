"use client";

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
import { Switch } from "@/components/ui/switch";
import {
  segmentCreateSchema,
  type SegmentFormValues,
} from "@/lib/validators/segments";

export type { SegmentFormValues };

export interface SegmentFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<SegmentFormValues>;
  onSubmit: (values: SegmentFormValues) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

// Segments no longer have group membership — groups live on contacts now
// (see contact_contact_groups). The old multi-group selector is gone.
export function SegmentForm({
  mode,
  initialValues,
  onSubmit,
  onCancel,
  isSubmitting,
}: SegmentFormProps) {
  const isEdit = mode === "edit";

  const form = useForm<SegmentFormValues>({
    resolver: zodResolver(segmentCreateSchema),
    defaultValues: {
      name: initialValues?.name ?? "",
      segment_id: initialValues?.segment_id ?? "",
      original_name: initialValues?.original_name ?? "",
      exclude_in_use_contacts:
        initialValues?.exclude_in_use_contacts ?? false,
    },
  });

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
                  placeholder="e.g. Q1 prospect list"
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
          name="segment_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Segment ID</FormLabel>
              <FormControl>
                <Input
                  placeholder="q1-prospects"
                  disabled={isEdit || isSubmitting}
                  readOnly={isEdit}
                  {...field}
                />
              </FormControl>
              <FormDescription>
                {isEdit
                  ? "Segment ID can't be changed after creation."
                  : "Letters, digits, hyphens, and underscores only."}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="exclude_in_use_contacts"
          render={({ field }) => (
            <FormItem className="flex items-start justify-between gap-3 rounded-md border p-3">
              <div className="grid gap-0.5">
                <FormLabel className="text-sm font-medium">
                  Exclude contacts in active campaigns
                </FormLabel>
                <FormDescription className="text-xs">
                  When on, contacts already snapshotted into another
                  active campaign&apos;s audience are removed from this
                  segment&apos;s effective audience. Lets you reserve
                  contacts to one in-flight campaign at a time.
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value ?? false}
                  onCheckedChange={field.onChange}
                  disabled={isSubmitting}
                />
              </FormControl>
            </FormItem>
          )}
        />

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
