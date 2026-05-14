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
import { Textarea } from "@/components/ui/textarea";
import { ColorPicker } from "@/components/color-picker";
import {
  contactGroupCreateSchema,
  type ContactGroupFormValues,
} from "@/lib/validators/contact-groups";

export type { ContactGroupFormValues };

export interface ContactGroupFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<ContactGroupFormValues>;
  onSubmit: (values: ContactGroupFormValues) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

export function ContactGroupForm({
  mode,
  initialValues,
  onSubmit,
  onCancel,
  isSubmitting,
}: ContactGroupFormProps) {
  const isEdit = mode === "edit";

  const form = useForm<ContactGroupFormValues>({
    resolver: zodResolver(contactGroupCreateSchema),
    defaultValues: {
      name: initialValues?.name ?? "",
      contact_group_id: initialValues?.contact_group_id ?? "",
      description: initialValues?.description ?? "",
      color: initialValues?.color ?? "",
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
