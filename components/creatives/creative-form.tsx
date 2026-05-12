"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

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
import { Textarea } from "@/components/ui/textarea";
import { calculateSmsSegments } from "@/lib/creative-helpers";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { cn } from "@/lib/utils";
import { creativeCreateSchema } from "@/lib/validators/creatives";

// Form values are the input shape — same fields as creativeCreateSchema but
// we want segment/brand/provider to use sentinel string values in the Select
// component for "none". We re-map before submitting.
const formSchema = z.object({
  offer_id: z.number().int().positive(),
  sms_provider_id: z.number().int().positive().nullable(),
  brand_id: z.number().int().positive().nullable(),
  text: z.string().min(1, "Message text is required").max(1600),
  creative_id: z
    .union([
      z
        .string()
        .trim()
        .max(80)
        .regex(/^[A-Za-z0-9_-]+$/, "Letters, digits, hyphens, underscores only"),
      z.literal(""),
    ])
    .optional(),
});
export type CreativeFormValues = z.input<typeof formSchema>;
export type CreativeFormSubmit = z.infer<typeof creativeCreateSchema>;

type OfferInfo = {
  id: number;
  name: string;
  color: string | null;
  status: string;
};
type ProviderInfo = {
  id: number;
  name: string;
  color: string | null;
  status: string;
};
type BrandInfo = {
  id: number;
  name: string;
  color: string | null;
  status: string;
};

const NONE = "__none__";

export interface CreativeFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<CreativeFormValues>;
  // Edit-mode extras displayed read-only
  slug?: string;
  currentStatus?: string;
  onSubmit: (values: CreativeFormSubmit) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

export function CreativeForm({
  mode,
  initialValues,
  slug,
  currentStatus,
  onSubmit,
  onCancel,
  isSubmitting,
}: CreativeFormProps) {
  const isEdit = mode === "edit";
  const offersApi = useApiCall<{ data: OfferInfo[] }>();
  const providersApi = useApiCall<{ data: ProviderInfo[] }>();
  const brandsApi = useApiCall<{ data: BrandInfo[] }>();
  const [offers, setOffers] = useState<OfferInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [brands, setBrands] = useState<BrandInfo[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(
    Boolean(initialValues?.creative_id),
  );
  const [slugCopied, setSlugCopied] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await offersApi.execute("/api/offers/list?pageSize=200");
      if (r.ok) setOffers(r.data.data.filter((o) => o.status === "active"));
    })();
  }, [offersApi.execute]);
  useEffect(() => {
    (async () => {
      const r = await providersApi.execute(
        "/api/providers/list?pageSize=200",
      );
      if (r.ok)
        setProviders(r.data.data.filter((p) => p.status === "active"));
    })();
  }, [providersApi.execute]);
  useEffect(() => {
    (async () => {
      const r = await brandsApi.execute("/api/brands/list?pageSize=200");
      if (r.ok) setBrands(r.data.data.filter((b) => b.status === "active"));
    })();
  }, [brandsApi.execute]);

  const form = useForm<CreativeFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      offer_id: initialValues?.offer_id ?? (undefined as unknown as number),
      sms_provider_id: initialValues?.sms_provider_id ?? null,
      brand_id: initialValues?.brand_id ?? null,
      text: initialValues?.text ?? "",
      creative_id: initialValues?.creative_id ?? "",
    },
  });

  const text = form.watch("text");
  const segments = useMemo(() => calculateSmsSegments(text ?? ""), [text]);

  // Text is locked once the creative is approved (ready/paused). The list
  // page passes currentStatus so we can disable the textarea inline.
  const textLocked =
    isEdit && currentStatus !== undefined && currentStatus !== "draft" && currentStatus !== "pending";

  async function copySlug() {
    if (!slug) return;
    try {
      await navigator.clipboard.writeText(slug);
      setSlugCopied(true);
      setTimeout(() => setSlugCopied(false), 1000);
    } catch {}
  }

  async function handleFormSubmit(values: CreativeFormValues) {
    await onSubmit({
      offer_id: values.offer_id,
      sms_provider_id: values.sms_provider_id ?? undefined,
      brand_id: values.brand_id ?? undefined,
      text: values.text,
      creative_id:
        values.creative_id && values.creative_id !== ""
          ? values.creative_id
          : undefined,
    });
  }

  const counterTone =
    segments.segments > 8
      ? "text-red-700 dark:text-red-400"
      : segments.segments > 4
        ? "text-amber-700 dark:text-amber-400"
        : "text-muted-foreground";

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(handleFormSubmit)}
        className="grid gap-4"
        noValidate
      >
        {slug ? (
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <span className="text-xs text-muted-foreground">Slug</span>
            <button
              type="button"
              onClick={copySlug}
              className="inline-flex items-center gap-1.5 font-mono hover:text-foreground"
            >
              {slug}
              {slugCopied ? (
                <Check className="size-3 text-emerald-600" aria-hidden />
              ) : (
                <Copy className="size-3 opacity-40" aria-hidden />
              )}
            </button>
          </div>
        ) : null}

        <FormField
          control={form.control}
          name="offer_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Offer</FormLabel>
              <Select
                value={field.value ? String(field.value) : ""}
                onValueChange={(v) => field.onChange(Number(v))}
                disabled={isSubmitting}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select an offer" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {offers.map((o) => (
                    <SelectItem key={o.id} value={String(o.id)}>
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: o.color ?? "#64748B" }}
                        />
                        {o.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="sms_provider_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Provider (optional)</FormLabel>
              <Select
                value={field.value === null ? NONE : String(field.value)}
                onValueChange={(v) =>
                  field.onChange(v === NONE ? null : Number(v))
                }
                disabled={isSubmitting}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value={NONE}>Unassigned</SelectItem>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: p.color ?? "#64748B" }}
                        />
                        {p.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="brand_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Brand (optional)</FormLabel>
              <Select
                value={field.value === null ? NONE : String(field.value)}
                onValueChange={(v) =>
                  field.onChange(v === NONE ? null : Number(v))
                }
                disabled={isSubmitting}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value={NONE}>Unassigned</SelectItem>
                  {brands.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: b.color ?? "#64748B" }}
                        />
                        {b.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="text"
          render={({ field }) => (
            <FormItem>
              <FormLabel>SMS body</FormLabel>
              <FormControl>
                <Textarea
                  rows={5}
                  placeholder="Your message…"
                  disabled={isSubmitting || textLocked}
                  className="font-mono text-sm"
                  {...field}
                />
              </FormControl>
              {textLocked ? (
                <FormDescription className="text-amber-700 dark:text-amber-400">
                  Text is locked once approved. Duplicate this creative to
                  iterate on copy.
                </FormDescription>
              ) : null}
              <div className={cn("text-xs tabular-nums", counterTone)}>
                {text ? (
                  <>
                    {segments.characters.toLocaleString()} characters ·{" "}
                    {segments.segments} segment
                    {segments.segments === 1 ? "" : "s"} ({segments.charset})
                    <span className="ml-2 text-muted-foreground">
                      {segments.remaining_in_segment} until next segment
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    Start typing your message
                  </span>
                )}
              </div>
              <FormMessage />
            </FormItem>
          )}
        />

        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          className="-mx-1 inline-flex items-center gap-1 self-start rounded px-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {advancedOpen ? (
            <ChevronDown className="size-3" aria-hidden />
          ) : (
            <ChevronRight className="size-3" aria-hidden />
          )}
          Advanced
        </button>

        {advancedOpen ? (
          <FormField
            control={form.control}
            name="creative_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>External creative ID (optional)</FormLabel>
                <FormControl>
                  <Input
                    placeholder="e.g. CR-2026-Q1-002"
                    disabled={isSubmitting}
                    {...field}
                    value={field.value ?? ""}
                  />
                </FormControl>
                <FormDescription>
                  Free-form identifier from an external system. Must be unique
                  across your organization.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}

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
            {isEdit ? "Save changes" : "Create draft"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
