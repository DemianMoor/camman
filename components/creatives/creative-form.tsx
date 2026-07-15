"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { SpamCheckStrip } from "@/components/spam/spam-check-strip";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { MultiSelectPicker } from "@/components/multi-select-picker";
import { calculateSmsSegments, containsEmDash } from "@/lib/creative-helpers";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { MAX_SEGMENTS } from "@/lib/sends/segments";
import { cn } from "@/lib/utils";
import {
  FUNNEL_STAGE_VALUES,
  QUALITY_VALUES,
  SEQUENCE_PLACEMENT_VALUES,
  type CreativeFunnelStage,
  type CreativeQuality,
  type CreativeSequencePlacement,
} from "@/lib/validators/creatives";

// Soft warning threshold. Long text doesn't block save — it just flags
// that the user may be pushing past one SMS segment once the brand prefix
// and stop text are prepended at stage send time.
const TEXT_WARN_THRESHOLD = 110;

const formSchema = z.object({
  text: z.string().min(1, "Message text is required").max(1600),
  creative_id: z
    .union([
      z
        .string()
        .trim()
        .max(80)
        .regex(
          /^[A-Za-z0-9_-]+$/,
          "Letters, digits, hyphens, underscores only",
        ),
      z.literal(""),
    ])
    .optional(),
  quality: z.enum(QUALITY_VALUES),
  sequence_placement: z.enum(SEQUENCE_PLACEMENT_VALUES),
  funnel_stage: z.enum(FUNNEL_STAGE_VALUES),
  applies_to_all_offers: z.boolean(),
  allow_multi_segment: z.boolean(),
  offer_ids: z.array(z.number().int().positive()),
});
export type CreativeFormValues = z.input<typeof formSchema>;

export type OfferInfo = {
  id: number;
  name: string;
  color: string | null;
  status: string;
};

const QUALITY_LABEL: Record<CreativeQuality, string> = {
  high: "High",
  average: "Average",
  poor: "Poor",
  unknown: "Unknown",
};

const SEQUENCE_LABEL: Record<CreativeSequencePlacement, string> = {
  warmup: "WarmUp",
  "1st": "1st",
  "2nd": "2nd",
  "3rd": "3rd",
  "4th": "4th",
  "5th": "5th",
  "6th": "6th",
  any: "Any",
  unknown: "Unknown",
};

const FUNNEL_STAGE_LABEL: Record<CreativeFunnelStage, string> = {
  start: "Start",
  clicked: "Clicked",
  checkout: "Checkout",
  ignored: "Ignored",
  unknown: "Unknown",
};

export interface CreativeFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<CreativeFormValues>;
  // Edit-mode extras displayed read-only
  slug?: string;
  // If the creative was scored previously (e.g. surfaced by the list endpoint's
  // cache join), pass it here so the strip prefills with the known score.
  initialSpamResult?: {
    score: number;
    label: "ham" | "suspicious" | "spam";
    verdict: "spam" | "not_spam";
    textHash: string;
  } | null;
  onSubmit: (values: CreativeFormValues) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

export function CreativeForm({
  mode,
  initialValues,
  slug,
  initialSpamResult,
  onSubmit,
  onCancel,
  isSubmitting,
}: CreativeFormProps) {
  const isEdit = mode === "edit";
  const offersApi = useApiCall<{ data: OfferInfo[] }>();
  const [offers, setOffers] = useState<OfferInfo[]>([]);
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

  const form = useForm<CreativeFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      text: initialValues?.text ?? "",
      creative_id: initialValues?.creative_id ?? "",
      quality: initialValues?.quality ?? "unknown",
      sequence_placement: initialValues?.sequence_placement ?? "unknown",
      funnel_stage: initialValues?.funnel_stage ?? "unknown",
      applies_to_all_offers: initialValues?.applies_to_all_offers ?? false,
      allow_multi_segment: initialValues?.allow_multi_segment ?? false,
      offer_ids: initialValues?.offer_ids ?? [],
    },
  });

  const text = form.watch("text");
  const appliesToAll = form.watch("applies_to_all_offers");
  const allowMultiSegment = form.watch("allow_multi_segment");
  const segments = useMemo(() => calculateSmsSegments(text ?? ""), [text]);
  const isLongText = (text?.length ?? 0) > TEXT_WARN_THRESHOLD;
  const hasEmDash = containsEmDash(text ?? "");

  // Auto-select offers when creating a creative and exactly one active
  // offer exists. Skipped in edit mode and when the org-wide toggle is
  // on (offer list is a fallback when applies_to_all is true).
  useEffect(() => {
    if (isEdit) return;
    if (appliesToAll) return;
    if (offers.length === 1 && (form.getValues("offer_ids") ?? []).length === 0) {
      form.setValue("offer_ids", [offers[0].id], { shouldDirty: false });
    }
  }, [isEdit, appliesToAll, offers, form]);

  async function copySlug() {
    if (!slug) return;
    try {
      await navigator.clipboard.writeText(slug);
      setSlugCopied(true);
      setTimeout(() => setSlugCopied(false), 1000);
    } catch {}
  }

  async function handleFormSubmit(values: CreativeFormValues) {
    // Surface the "must have at least one association" rule before the API
    // would (the validator enforces it server-side too). When applies_to_all
    // is on the offer list is allowed to be empty.
    if (!values.applies_to_all_offers && values.offer_ids.length === 0) {
      form.setError("offer_ids", {
        message: "Must apply to at least one offer (or select 'All offers').",
      });
      return;
    }
    await onSubmit({
      ...values,
      creative_id:
        values.creative_id && values.creative_id !== ""
          ? values.creative_id
          : undefined,
    });
  }

  const counterTone = isLongText
    ? "text-red-700 dark:text-red-400"
    : segments.segments > MAX_SEGMENTS
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
          name="text"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>SMS body</FormLabel>
              <FormControl>
                <Textarea
                  rows={5}
                  placeholder="Your message…"
                  disabled={isSubmitting}
                  className={cn(
                    "font-mono text-sm",
                    isLongText && "border-red-400 focus-visible:ring-red-400",
                  )}
                  {...field}
                />
              </FormControl>
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
              {isLongText ? (
                <FormDescription className="text-red-700 dark:text-red-400">
                  Long creative — over {TEXT_WARN_THRESHOLD} characters may
                  push past 1 SMS segment when assembled with brand prefix and
                  stop text.
                </FormDescription>
              ) : null}
              {hasEmDash ? (
                <FormDescription className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                  <TriangleAlert
                    className="mt-0.5 size-3.5 shrink-0"
                    aria-hidden
                  />
                  <span>
                    Contains an em dash (—). It forces UCS-2 encoding (shorter
                    segments) and reads as a spam/AI tell — consider a hyphen
                    (-) instead.
                  </span>
                </FormDescription>
              ) : null}
              {segments.segments > MAX_SEGMENTS ? (
                <FormDescription className="flex items-start gap-1.5 text-red-700 dark:text-red-400">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>
                    Exceeds the hard limit of {MAX_SEGMENTS} segments — this
                    will be refused at send no matter what. Shorten the text.
                  </span>
                </FormDescription>
              ) : segments.segments > 1 && !allowMultiSegment ? (
                <FormDescription className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>
                    Renders to {segments.segments} segments. Turn on &quot;Allow
                    multi-segment&quot; below to send this, or shorten the text
                    to fit 1 segment.
                  </span>
                </FormDescription>
              ) : null}
              <SpamCheckStrip
                text={text ?? ""}
                initialResult={
                  initialSpamResult
                    ? { ...initialSpamResult, cached: true, latencyMs: 0, error: null }
                    : null
                }
                disabled={isSubmitting}
                className="pt-1"
              />
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-3 rounded-md border p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label className="cursor-pointer" htmlFor="applies-to-all">
                Apply to all offers
              </Label>
              <p className="text-xs text-muted-foreground">
                When on, this creative is eligible for every offer in your
                organization. The offer list below becomes a fallback list,
                not a restriction.
              </p>
            </div>
            <FormField
              control={form.control}
              name="applies_to_all_offers"
              render={({ field }) => (
                <Switch
                  id="applies-to-all"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={isSubmitting}
                />
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="offer_ids"
            render={({ field }) => (
              <FormItem>
                <FormLabel
                  className={appliesToAll ? "opacity-60" : ""}
                  required={!appliesToAll}
                >
                  Offers
                </FormLabel>
                <FormControl>
                  <MultiSelectPicker
                    options={offers.map((o) => ({
                      id: o.id,
                      label: o.name,
                      color: o.color,
                    }))}
                    value={field.value ?? []}
                    onChange={(next) => field.onChange(next as number[])}
                    placeholder="Select offers…"
                    selectedLabel={(n) =>
                      `${n} offer${n === 1 ? "" : "s"} selected`
                    }
                    isLoading={offersApi.isLoading && offers.length === 0}
                    disabled={isSubmitting || appliesToAll}
                    emptyMessage="No active offers available."
                    searchPlaceholder="Search offers…"
                  />
                </FormControl>
                <FormDescription>
                  {appliesToAll
                    ? "Disabled — this creative is org-wide."
                    : null}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid gap-3 rounded-md border p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label className="cursor-pointer" htmlFor="allow-multi-segment">
                Allow multi-segment
              </Label>
              <p className="text-xs text-muted-foreground">
                Off (default): this creative is refused at send if it renders
                to more than 1 SMS segment. On: allows up to {MAX_SEGMENTS}{" "}
                segments — never more, a hard limit.
              </p>
            </div>
            <FormField
              control={form.control}
              name="allow_multi_segment"
              render={({ field }) => (
                <Switch
                  id="allow-multi-segment"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={isSubmitting}
                />
              )}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField
            control={form.control}
            name="quality"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Quality</FormLabel>
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
                    {QUALITY_VALUES.map((q) => (
                      <SelectItem key={q} value={q}>
                        {QUALITY_LABEL[q]}
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
            name="sequence_placement"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Sequence placement</FormLabel>
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
                    {SEQUENCE_PLACEMENT_VALUES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {SEQUENCE_LABEL[s]}
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
            name="funnel_stage"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Funnel Stage</FormLabel>
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
                    {FUNNEL_STAGE_VALUES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {FUNNEL_STAGE_LABEL[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

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
                <FormLabel>External creative ID</FormLabel>
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
            {isEdit ? "Save changes" : "Create"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
