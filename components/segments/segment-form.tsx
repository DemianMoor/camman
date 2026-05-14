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
