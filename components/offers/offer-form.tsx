"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useFieldArray, useForm } from "react-hook-form";
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
import { Separator } from "@/components/ui/separator";
import { ColorPicker } from "@/components/color-picker";
import { isEntityAvailable } from "@/lib/feature-flags";
import { useApiCall } from "@/lib/hooks/use-api-call";
import {
  offerCreateSchema,
  type OfferFormValues,
} from "@/lib/validators/offers";

export type { OfferFormValues };

export interface OfferFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<OfferFormValues>;
  onSubmit: (values: OfferFormValues) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

type Network = {
  id: number;
  name: string;
  avatar_url: string | null;
  color: string | null;
};

type NetworksListResponse = {
  data: Network[];
  totalCount: number;
};

const UNASSIGNED = "__unassigned__";

export function OfferForm({
  mode,
  initialValues,
  onSubmit,
  onCancel,
  isSubmitting,
}: OfferFormProps) {
  const isEdit = mode === "edit";

  const form = useForm<OfferFormValues>({
    resolver: zodResolver(offerCreateSchema),
    defaultValues: {
      name: initialValues?.name ?? "",
      offer_id: initialValues?.offer_id ?? "",
      postfix: initialValues?.postfix ?? "",
      base_url: initialValues?.base_url ?? "",
      network_id: initialValues?.network_id ?? null,
      payout_model: initialValues?.payout_model ?? "cpa",
      payout_cpa: initialValues?.payout_cpa,
      payout_revshare: initialValues?.payout_revshare,
      sales_pages: initialValues?.sales_pages ?? [],
      avatar_url: initialValues?.avatar_url ?? "",
      color: initialValues?.color ?? "",
    },
  });

  const payoutModel = form.watch("payout_model");

  const {
    fields: salesPageFields,
    append: appendSalesPage,
    remove: removeSalesPage,
  } = useFieldArray({
    control: form.control,
    name: "sales_pages",
  });

  // Networks picker — gated on the feature flag so we don't make a speculative
  // request before Step 5.2 ships the endpoint.
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
        className="grid gap-6"
        noValidate
      >
        {/* Section 1 — Identity & Tracking */}
        <section className="grid gap-4">
          <div className="grid gap-1">
            <h3 className="text-sm font-medium">Identity &amp; tracking</h3>
            <p className="text-xs text-muted-foreground">
              How the offer is identified and where its traffic is sent.
            </p>
          </div>

          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input
                    placeholder="e.g. Acme Loan Application"
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
            name="offer_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Offer ID</FormLabel>
                <FormControl>
                  <Input
                    placeholder="acme-loan"
                    disabled={isEdit || isSubmitting}
                    readOnly={isEdit}
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  {isEdit
                    ? "Offer ID can't be changed after creation."
                    : "Letters, digits, hyphens, and underscores only."}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="postfix"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Postfix</FormLabel>
                <FormControl>
                  <Input
                    placeholder="hop"
                    disabled={isSubmitting}
                    {...field}
                    value={field.value ?? ""}
                  />
                </FormControl>
                <FormDescription>
                  URL parameter name for tracking. Optional.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="base_url"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Base URL</FormLabel>
                <FormControl>
                  <Input
                    placeholder="https://network.example/offer"
                    disabled={isSubmitting}
                    {...field}
                    value={field.value ?? ""}
                  />
                </FormControl>
                <FormDescription>Destination URL stem. Optional.</FormDescription>
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
        </section>

        <Separator />

        {/* Section 2 — Payout */}
        <section className="grid gap-4">
          <div className="grid gap-1">
            <h3 className="text-sm font-medium">Payout</h3>
            <p className="text-xs text-muted-foreground">
              How this offer pays out per conversion.
            </p>
          </div>

          <FormField
            control={form.control}
            name="payout_model"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Payout model</FormLabel>
                <Select
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={isSubmitting}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="cpa">CPA (fixed)</SelectItem>
                    <SelectItem value="revshare">
                      Revshare (percentage)
                    </SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {payoutModel === "cpa" ? (
            <FormField
              control={form.control}
              name="payout_cpa"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>CPA payout (USD)</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                        $
                      </span>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        className="pl-7"
                        placeholder="0.00"
                        disabled={isSubmitting}
                        value={field.value ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          field.onChange(v === "" ? undefined : Number(v));
                        }}
                      />
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          ) : (
            <FormField
              control={form.control}
              name="payout_revshare"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Revshare percentage</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        max="100"
                        className="pr-7"
                        placeholder="0.00"
                        disabled={isSubmitting}
                        value={field.value ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          field.onChange(v === "" ? undefined : Number(v));
                        }}
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                        %
                      </span>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </section>

        <Separator />

        {/* Section 3 — Sales Pages */}
        <section className="grid gap-3">
          <div className="grid gap-1">
            <h3 className="text-sm font-medium">Sales pages</h3>
            <p className="text-xs text-muted-foreground">
              Landing-page variants for this offer. Up to 10.
            </p>
          </div>

          {salesPageFields.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No sales pages yet. Add one to enable selection on campaigns.
            </p>
          ) : (
            <div className="grid gap-2">
              {salesPageFields.map((sp, index) => (
                <div
                  key={sp.id}
                  className="grid grid-cols-[1fr_2fr_auto] items-start gap-2"
                >
                  <FormField
                    control={form.control}
                    name={`sales_pages.${index}.label`}
                    render={({ field }) => (
                      <FormItem>
                        <FormControl>
                          <Input
                            placeholder="Label"
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
                    name={`sales_pages.${index}.url`}
                    render={({ field }) => (
                      <FormItem>
                        <FormControl>
                          <Input
                            placeholder="https://example.com/page"
                            disabled={isSubmitting}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove sales page"
                    disabled={isSubmitting}
                    onClick={() => removeSalesPage(index)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isSubmitting || salesPageFields.length >= 10}
            onClick={() => appendSalesPage({ label: "", url: "" })}
            className="w-fit"
          >
            <Plus className="size-4" aria-hidden /> Add sales page
          </Button>
        </section>

        <Separator />

        {/* Section 4 — Network */}
        <section className="grid gap-4">
          <div className="grid gap-1">
            <h3 className="text-sm font-medium">Affiliate network</h3>
            <p className="text-xs text-muted-foreground">
              Which network this offer comes from.
            </p>
          </div>

          <FormField
            control={form.control}
            name="network_id"
            render={({ field }) => {
              const value =
                field.value == null ? UNASSIGNED : String(field.value);
              return (
                <FormItem>
                  <FormLabel>Network</FormLabel>
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
                              ? "Networks not yet available — see Step 5.2"
                              : "Unassigned"
                          }
                        />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
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
                  <FormMessage />
                </FormItem>
              );
            }}
          />
        </section>

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
