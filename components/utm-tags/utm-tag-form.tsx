"use client";

import { useEffect, useState } from "react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ColorPicker } from "@/components/color-picker";
import { isEntityAvailable } from "@/lib/feature-flags";
import { useApiCall } from "@/lib/hooks/use-api-call";
import {
  utmTagCreateSchema,
  type UtmTagFormValues,
} from "@/lib/validators/utm-tags";

export type { UtmTagFormValues };

export interface UtmTagFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<UtmTagFormValues>;
  onSubmit: (values: UtmTagFormValues) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

type Network = {
  id: number;
  name: string;
  color: string | null;
};
type NetworksListResponse = { data: Network[]; totalCount: number };

const UNASSIGNED = "__unassigned__";

export function UtmTagForm({
  mode,
  initialValues,
  onSubmit,
  onCancel,
  isSubmitting,
}: UtmTagFormProps) {
  const isEdit = mode === "edit";

  const form = useForm<UtmTagFormValues>({
    resolver: zodResolver(utmTagCreateSchema),
    defaultValues: {
      label: initialValues?.label ?? "",
      tag_id: initialValues?.tag_id ?? "",
      value_source: initialValues?.value_source ?? "",
      affiliate_network_id: initialValues?.affiliate_network_id ?? null,
      color: initialValues?.color ?? "",
    },
  });

  const networksAvailable = isEntityAvailable("networks");
  const networksApi = useApiCall<NetworksListResponse>();
  const [networks, setNetworks] = useState<Network[]>([]);

  useEffect(() => {
    if (!networksAvailable) return;
    let cancelled = false;
    (async () => {
      const result = await networksApi.execute(
        "/api/networks/list?pageSize=100",
      );
      if (cancelled) return;
      if (result.ok) setNetworks(result.data.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [networksAvailable, networksApi.execute]);

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="grid gap-4"
        noValidate
      >
        <FormField
          control={form.control}
          name="label"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Label</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. Sub ID or Campaign Slug"
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
          name="tag_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Tag ID</FormLabel>
              <FormControl>
                <Input
                  placeholder="sub1"
                  disabled={isEdit || isSubmitting}
                  readOnly={isEdit}
                  {...field}
                />
              </FormControl>
              <FormDescription>
                {isEdit
                  ? "Tag ID can't be changed after creation."
                  : "Letters, digits, hyphens, and underscores only."}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="value_source"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Value source</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. campaign_slug, brand_name, or a literal value"
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormDescription>
                What produces this tag&apos;s value at link-build time.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="affiliate_network_id"
          render={({ field }) => {
            const value =
              field.value == null ? UNASSIGNED : String(field.value);
            return (
              <FormItem>
                <FormLabel>Network scope</FormLabel>
                <Select
                  value={value}
                  onValueChange={(v) =>
                    field.onChange(v === UNASSIGNED ? null : Number(v))
                  }
                  disabled={isSubmitting || !networksAvailable}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue
                        placeholder={
                          !networksAvailable
                            ? "Networks not yet available"
                            : "Unassigned (any network)"
                        }
                      />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>
                      Unassigned (any network)
                    </SelectItem>
                    {networks.map((n) => (
                      <SelectItem key={n.id} value={String(n.id)}>
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="size-3 rounded-full"
                            style={{ backgroundColor: n.color ?? "#64748B" }}
                          />
                          {n.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  Optional. Limits the tag to one network.
                </FormDescription>
                <FormMessage />
              </FormItem>
            );
          }}
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
