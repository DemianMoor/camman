"use client";

import { Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";

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
import { ColorPicker } from "@/components/color-picker";
import { brandCreateSchema } from "@/lib/validators/brands";

// We use the create schema for both modes. On edit, brand_id is rendered as a
// read-only input with its existing value, so it always validates.
const formSchema = brandCreateSchema;

export type BrandFormValues = z.infer<typeof formSchema>;

export interface BrandFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<BrandFormValues>;
  onSubmit: (values: BrandFormValues) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

export function BrandForm({
  mode,
  initialValues,
  onSubmit,
  onCancel,
  isSubmitting,
}: BrandFormProps) {
  const form = useForm<BrandFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: initialValues?.name ?? "",
      brand_id: initialValues?.brand_id ?? "",
      short_link_base: initialValues?.short_link_base ?? "",
      avatar_url: initialValues?.avatar_url ?? "",
      color: initialValues?.color ?? "",
    },
  });

  const isEdit = mode === "edit";

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
                  placeholder="e.g. Acme Mobile"
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
          name="brand_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Brand ID</FormLabel>
              <FormControl>
                <Input
                  placeholder="acme-mobile"
                  disabled={isEdit || isSubmitting}
                  readOnly={isEdit}
                  {...field}
                />
              </FormControl>
              <FormDescription>
                {isEdit
                  ? "Brand ID can't be changed after creation."
                  : "Letters, digits, hyphens, and underscores only. Used as an external identifier."}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="short_link_base"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Short link base</FormLabel>
              <FormControl>
                <Input
                  placeholder="lnk.example.com"
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
          name="avatar_url"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Avatar URL</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://…"
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
