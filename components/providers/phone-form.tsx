"use client";

import { useEffect, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isEntityAvailable } from "@/lib/feature-flags";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { formatPhoneInternational } from "@/lib/phone-validation";
import {
  providerPhoneCreateSchema,
  providerPhoneUpdateSchema,
} from "@/lib/validators/provider-phones";

// Shape of "create" form values (raw input phone_number + cost + optional brand).
// We don't use UpdateSchema directly; in edit mode we omit phone_number from
// the form values and just send the patch.
export type PhoneFormValues = z.input<typeof providerPhoneCreateSchema>;

type Brand = {
  id: number;
  name: string;
  color: string | null;
  avatar_url: string | null;
};
type BrandsListResponse = { data: Brand[]; totalCount: number };

const UNASSIGNED = "__unassigned__";

export interface PhoneFormProps {
  mode: "create" | "edit";
  /** create mode: only `cost_per_sms` / `brand_id` are used.
   *  edit mode: `phone_number` is used for read-only display. */
  initialValues?: Partial<PhoneFormValues>;
  /** Required in edit mode for the read-only display. */
  existingPhoneNumber?: string;
  onSubmit: (values: PhoneFormValues) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

export function PhoneForm({
  mode,
  initialValues,
  existingPhoneNumber,
  onSubmit,
  onCancel,
  isSubmitting,
}: PhoneFormProps) {
  const isEdit = mode === "edit";

  // In edit mode we hide phone_number from validation by using the update
  // schema (which omits it). In create mode we use the create schema.
  // RHF needs a single resolver; we use a conditional schema below.
  const form = useForm<PhoneFormValues>({
    resolver: zodResolver(
      isEdit
        ? (providerPhoneUpdateSchema as unknown as typeof providerPhoneCreateSchema)
        : providerPhoneCreateSchema,
    ),
    defaultValues: {
      phone_number: initialValues?.phone_number ?? "",
      cost_per_sms: initialValues?.cost_per_sms ?? 0,
      brand_id: initialValues?.brand_id ?? null,
    },
  });

  // Brands picker — gated on feature flag (brands is true, so the fetch fires).
  const brandsAvailable = isEntityAvailable("brands");
  const brandsApi = useApiCall<BrandsListResponse>();
  const [brands, setBrands] = useState<Brand[]>([]);

  useEffect(() => {
    if (!brandsAvailable) return;
    let cancelled = false;
    (async () => {
      const result = await brandsApi.execute("/api/brands/list?pageSize=100");
      if (cancelled) return;
      if (result.ok) setBrands(result.data.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [brandsAvailable, brandsApi.execute]);

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="grid gap-4"
        noValidate
      >
        {isEdit ? (
          <FormItem>
            <FormLabel>Phone number</FormLabel>
            <FormControl>
              <Input
                readOnly
                disabled
                value={
                  existingPhoneNumber
                    ? formatPhoneInternational(existingPhoneNumber)
                    : ""
                }
              />
            </FormControl>
            <FormDescription>
              Phone number can&apos;t be changed after creation.
            </FormDescription>
          </FormItem>
        ) : (
          <FormField
            control={form.control}
            name="phone_number"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Phone number</FormLabel>
                <FormControl>
                  <Input
                    placeholder="+1 202 555 0199 or 2025550199"
                    disabled={isSubmitting}
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  E.164 (international) format preferred. US numbers without a
                  country code will be auto-prepended with +1.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <FormField
          control={form.control}
          name="cost_per_sms"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Cost per SMS (USD)</FormLabel>
              <FormControl>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    $
                  </span>
                  <Input
                    type="number"
                    step="0.0001"
                    min="0"
                    className="pl-7"
                    placeholder="0.0000"
                    disabled={isSubmitting}
                    value={field.value ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      field.onChange(v === "" ? 0 : Number(v));
                    }}
                  />
                </div>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="brand_id"
          render={({ field }) => {
            const value =
              field.value == null ? UNASSIGNED : String(field.value);
            return (
              <FormItem>
                <FormLabel>Brand (optional)</FormLabel>
                <Select
                  value={value}
                  onValueChange={(v) =>
                    field.onChange(v === UNASSIGNED ? null : Number(v))
                  }
                  disabled={isSubmitting || !brandsAvailable}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Unassigned" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                    {brands.map((b) => (
                      <SelectItem key={b.id} value={String(b.id)}>
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="size-3 rounded-full"
                            style={{ backgroundColor: b.color ?? "#64748B" }}
                          />
                          {b.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  Associate this phone with a brand for reporting.
                </FormDescription>
                <FormMessage />
              </FormItem>
            );
          }}
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
            {isEdit ? "Save changes" : "Add phone"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
