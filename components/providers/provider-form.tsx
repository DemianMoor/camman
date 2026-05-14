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
import { ColorPicker } from "@/components/color-picker";
import {
  providerCreateSchema,
  type ProviderFormValues,
} from "@/lib/validators/providers";

export type { ProviderFormValues };

export interface ProviderFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<ProviderFormValues>;
  onSubmit: (values: ProviderFormValues) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

export function ProviderForm({
  mode,
  initialValues,
  onSubmit,
  onCancel,
  isSubmitting,
}: ProviderFormProps) {
  const isEdit = mode === "edit";

  const form = useForm<ProviderFormValues>({
    resolver: zodResolver(providerCreateSchema),
    defaultValues: {
      name: initialValues?.name ?? "",
      sms_provider_id: initialValues?.sms_provider_id ?? "",
      short_link_supported: initialValues?.short_link_supported ?? false,
      short_link_example: initialValues?.short_link_example ?? "",
      avatar_url: initialValues?.avatar_url ?? "",
      color: initialValues?.color ?? "",
    },
  });

  const shortLinkSupported = form.watch("short_link_supported");

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
                  placeholder="e.g. SendNexus"
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
          name="sms_provider_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Provider ID</FormLabel>
              <FormControl>
                <Input
                  placeholder="sendnexus"
                  disabled={isEdit || isSubmitting}
                  readOnly={isEdit}
                  {...field}
                />
              </FormControl>
              <FormDescription>
                {isEdit
                  ? "Provider ID can't be changed after creation."
                  : "Letters, digits, hyphens, and underscores only."}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="short_link_supported"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start gap-3 rounded-md border p-3">
              <FormControl>
                <Switch
                  checked={!!field.value}
                  onCheckedChange={field.onChange}
                  disabled={isSubmitting}
                />
              </FormControl>
              <div className="grid gap-1">
                <FormLabel>Short links supported</FormLabel>
                <FormDescription>
                  This provider can shorten links automatically.
                </FormDescription>
              </div>
            </FormItem>
          )}
        />

        {shortLinkSupported ? (
          <FormField
            control={form.control}
            name="short_link_example"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Short link example</FormLabel>
                <FormControl>
                  <Input
                    placeholder="lnk.example.com/abc123"
                    disabled={isSubmitting}
                    {...field}
                    value={field.value ?? ""}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}

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
                  value={field.value ?? ""}
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
