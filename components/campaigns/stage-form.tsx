"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { calculateSmsSegments } from "@/lib/creative-helpers";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { formatPhoneInternational } from "@/lib/phone-validation";
import { cn } from "@/lib/utils";

// =============== Types ===============

export interface StageFormValues {
  label: string;
  creative_id: number | null;
  sms_provider_id: number | null;
  provider_phone_id: number | null;
  sales_page_label: string;
  stop_text: string;
  include_no_status: boolean;
  include_clickers: boolean;
  exclude_clickers: boolean;
  scheduled_at: string;
  notes: string;
}

type Creative = {
  id: number;
  slug: string;
  text: string;
  status: string;
  offer_id: number;
};
type Provider = {
  id: number;
  name: string;
  color: string | null;
  status: string;
};
type ProviderPhone = {
  id: number;
  phone_number: string;
  cost_per_sms: string;
  status: string;
};
type SalesPage = { label: string; url: string };
type BrandInfo = { id: number; name: string; color: string | null };
type OfferInfo = {
  id: number;
  name: string;
  color: string | null;
  sales_pages?: SalesPage[];
};

type AudiencePreview = {
  count: number;
  breakdown: {
    no_status: number;
    clickers: number;
    excluded_for_optout: number;
  };
  pool_size: number;
};

export interface StageFormProps {
  mode: "create" | "edit";
  campaignId: number;
  // Only set in edit mode; needed for the per-stage export URL.
  stageId?: number;
  campaign: {
    id: number;
    name: string;
    brand: BrandInfo | null;
    offer: OfferInfo | null;
    audience_snapshot_count: number;
  };
  // Edit-mode-only: current results counters + handlers for the inline
  // Results section. Omit for create mode.
  resultsCounters?: {
    sms_count: number;
    delivered_count: number;
    opt_out_count: number;
    click_count: number;
    total_cost: string;
  };
  onImportResults?: () => void;
  onViewImportHistory?: () => void;
  initialValues?: Partial<StageFormValues>;
  onSubmit: (values: StageFormValues) => Promise<void>;
  onCancel: () => void;
  isSubmitting: boolean;
}

const NONE = "__none__";

const DEFAULT_VALUES: StageFormValues = {
  label: "",
  creative_id: null,
  sms_provider_id: null,
  provider_phone_id: null,
  sales_page_label: "",
  stop_text: "Stop to END",
  include_no_status: true,
  include_clickers: false,
  exclude_clickers: false,
  scheduled_at: "",
  notes: "",
};

// =============== Component ===============

export function StageForm({
  mode,
  campaignId,
  stageId,
  campaign,
  resultsCounters,
  onImportResults,
  onViewImportHistory,
  initialValues,
  onSubmit,
  onCancel,
  isSubmitting,
}: StageFormProps) {
  const isEdit = mode === "edit";

  // Reference data
  const creativesApi = useApiCall<{ data: Creative[] }>();
  const providersApi = useApiCall<{ data: Provider[] }>();
  const phonesApi = useApiCall<{ data: ProviderPhone[] }>();
  const previewApi = useApiCall<AudiencePreview>();
  const [creatives, setCreatives] = useState<Creative[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [phones, setPhones] = useState<ProviderPhone[]>([]);

  // Creatives are filtered by the campaign's offer + status=ready so we
  // don't accidentally send unfinished copy. If the campaign has no offer
  // yet (rare — drafts), skip the fetch.
  useEffect(() => {
    if (!campaign.offer?.id) return;
    (async () => {
      const r = await creativesApi.execute(
        `/api/creatives/list?pageSize=200&offer_id=${campaign.offer!.id}&status=ready`,
      );
      if (r.ok) setCreatives(r.data.data);
    })();
  }, [campaign.offer?.id, creativesApi.execute]);

  useEffect(() => {
    (async () => {
      const r = await providersApi.execute(
        "/api/providers/list?pageSize=200&status=active",
      );
      if (r.ok) setProviders(r.data.data);
    })();
  }, [providersApi.execute]);

  // Form setup
  const form = useForm<StageFormValues>({
    defaultValues: { ...DEFAULT_VALUES, ...initialValues },
  });

  const watchedCreativeId = form.watch("creative_id");
  const watchedProviderId = form.watch("sms_provider_id");
  const watchedPhoneId = form.watch("provider_phone_id");
  const watchedStopText = form.watch("stop_text");
  const watchedIncludeNoStatus = form.watch("include_no_status");
  const watchedIncludeClickers = form.watch("include_clickers");
  const watchedExcludeClickers = form.watch("exclude_clickers");

  // Provider phones reload when the selected provider changes. If the
  // currently selected phone doesn't belong to the new provider, clear it.
  useEffect(() => {
    if (watchedProviderId === null) {
      setPhones([]);
      if (watchedPhoneId !== null) {
        form.setValue("provider_phone_id", null, { shouldDirty: true });
      }
      return;
    }
    let cancelled = false;
    (async () => {
      const r = await phonesApi.execute(
        `/api/providers/${watchedProviderId}/phones?status=active`,
      );
      if (cancelled) return;
      if (r.ok) {
        setPhones(r.data.data);
        // If the current phone selection isn't valid for the new
        // provider, drop it.
        if (
          watchedPhoneId !== null &&
          !r.data.data.some((p) => p.id === watchedPhoneId)
        ) {
          form.setValue("provider_phone_id", null, { shouldDirty: true });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedProviderId, phonesApi.execute]);

  // ============ SMS preview ============
  const selectedCreative = useMemo(
    () => creatives.find((c) => c.id === watchedCreativeId) ?? null,
    [creatives, watchedCreativeId],
  );
  const brandName = campaign.brand?.name ?? "";
  const assembledSms = selectedCreative
    ? `${brandName}: ${selectedCreative.text}\n${watchedStopText}`
    : "";
  const segments = useMemo(
    () => calculateSmsSegments(assembledSms),
    [assembledSms],
  );
  const counterTone =
    segments.segments > 8
      ? "text-red-700 dark:text-red-400"
      : segments.segments > 4
        ? "text-amber-700 dark:text-amber-400"
        : "text-muted-foreground";

  // ============ Audience preview (debounced, stale-safe) ============
  const [audiencePreview, setAudiencePreview] =
    useState<AudiencePreview | null>(null);
  const [audienceError, setAudienceError] = useState<string | null>(null);
  const [audienceLoading, setAudienceLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setAudienceLoading(true);
      const result = await previewApi.execute(
        `/api/campaigns/${campaignId}/stages/audience-preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            include_no_status: watchedIncludeNoStatus,
            include_clickers: watchedIncludeClickers,
            exclude_clickers: watchedExcludeClickers,
          }),
        },
      );
      if (cancelled) return;
      setAudienceLoading(false);
      if (result.ok) {
        setAudiencePreview(result.data);
        setAudienceError(null);
      } else {
        setAudienceError(result.error);
        setAudiencePreview(null);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [
    campaignId,
    watchedIncludeNoStatus,
    watchedIncludeClickers,
    watchedExcludeClickers,
    previewApi.execute,
  ]);

  // Mutex enforcement for the clicker toggles
  function setIncludeClickers(v: boolean) {
    form.setValue("include_clickers", v, { shouldDirty: true });
    if (v) form.setValue("exclude_clickers", false, { shouldDirty: true });
  }
  function setExcludeClickers(v: boolean) {
    form.setValue("exclude_clickers", v, { shouldDirty: true });
    if (v) form.setValue("include_clickers", false, { shouldDirty: true });
  }

  // Submit
  async function handleSave() {
    await onSubmit(form.getValues());
  }

  const offerSalesPages = campaign.offer?.sales_pages ?? [];
  const audienceEmpty =
    audiencePreview !== null && audiencePreview.count === 0;

  return (
    <Form {...form}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
        className="grid gap-6"
        noValidate
      >
        {/* ============ Identity ============ */}
        <section className="grid gap-4">
          <SectionHeader title="Identity" />
          <FormField
            control={form.control}
            name="label"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Label (optional)</FormLabel>
                <FormControl>
                  <Input
                    placeholder="e.g. Day 1 Initial Push"
                    disabled={isSubmitting}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </section>

        <Separator />

        {/* ============ Creative & SMS ============ */}
        <section className="grid gap-4">
          <SectionHeader title="Creative & SMS" />

          <FormField
            control={form.control}
            name="creative_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Creative</FormLabel>
                <Select
                  value={field.value === null ? NONE : String(field.value)}
                  onValueChange={(v) =>
                    field.onChange(v === NONE ? null : Number(v))
                  }
                  disabled={isSubmitting}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Pick a ready creative" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NONE}>None</SelectItem>
                    {creatives.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        <span className="inline-flex items-center gap-2">
                          <span className="font-mono text-xs">{c.slug}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {c.text.slice(0, 50)}
                            {c.text.length > 50 ? "…" : ""}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  Only creatives in the &quot;ready&quot; state and tied to
                  this campaign&apos;s offer are shown.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="sales_page_label"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Sales page</FormLabel>
                <Select
                  value={field.value === "" ? NONE : field.value}
                  onValueChange={(v) =>
                    field.onChange(v === NONE ? "" : v)
                  }
                  disabled={isSubmitting || offerSalesPages.length === 0}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue
                        placeholder={
                          offerSalesPages.length === 0
                            ? "No sales pages on this offer"
                            : "Choose a sales page"
                        }
                      />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NONE}>None</SelectItem>
                    {offerSalesPages.map((sp) => (
                      <SelectItem key={sp.label} value={sp.label}>
                        {sp.label}
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
            name="stop_text"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Stop text</FormLabel>
                <FormControl>
                  <Input disabled={isSubmitting} {...field} />
                </FormControl>
                <FormDescription>
                  Appended on a new line to the assembled SMS.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* SMS preview */}
          <Card>
            <CardContent className="grid gap-2 pt-6 text-sm">
              <div className="text-xs uppercase text-muted-foreground">
                SMS preview
              </div>
              {selectedCreative ? (
                <pre className="whitespace-pre-wrap rounded-md bg-muted/40 p-3 font-mono text-sm">
                  {assembledSms}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Select a creative to preview the SMS.
                </p>
              )}
              {selectedCreative ? (
                <div className={cn("text-xs tabular-nums", counterTone)}>
                  {segments.characters.toLocaleString()} characters ·{" "}
                  {segments.segments} segment
                  {segments.segments === 1 ? "" : "s"} ({segments.charset})
                </div>
              ) : null}
            </CardContent>
          </Card>
        </section>

        <Separator />

        {/* ============ Provider & Phone ============ */}
        <section className="grid gap-4">
          <SectionHeader title="Provider & Phone" />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="sms_provider_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Provider</FormLabel>
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
                              style={{
                                backgroundColor: p.color ?? "#64748B",
                              }}
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
              name="provider_phone_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone number</FormLabel>
                  <Select
                    value={field.value === null ? NONE : String(field.value)}
                    onValueChange={(v) =>
                      field.onChange(v === NONE ? null : Number(v))
                    }
                    disabled={
                      isSubmitting ||
                      watchedProviderId === null ||
                      phones.length === 0
                    }
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue
                          placeholder={
                            watchedProviderId === null
                              ? "Pick a provider first"
                              : phones.length === 0
                                ? "No active phones for this provider"
                                : "Unassigned"
                          }
                        />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE}>Unassigned</SelectItem>
                      {phones.map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          <span className="font-mono text-xs">
                            {formatPhoneInternational(p.phone_number)}
                          </span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            ${Number(p.cost_per_sms).toFixed(4)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </section>

        <Separator />

        {/* ============ Audience filters ============ */}
        <section className="grid gap-4">
          <div className="flex items-center justify-between gap-3">
            <SectionHeader title="Audience" />
            {isEdit && stageId !== undefined ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={audienceEmpty}
                title={
                  audienceEmpty
                    ? "Stage has no audience — adjust filters to enable export."
                    : undefined
                }
                onClick={() => {
                  if (audienceEmpty) return;
                  window.open(
                    `/api/campaigns/${campaignId}/stages/${stageId}/export-phones`,
                    "_blank",
                    "noopener",
                  );
                }}
              >
                Export phones (CSV) →
              </Button>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            These filters select a subset of the campaign&apos;s frozen
            audience for this stage. Opt-outs accumulated since campaign
            creation are always excluded.
          </p>

          <div className="grid gap-3 rounded-md border p-4">
            <FilterToggle
              label="Include no-status contacts"
              description="Contacts with no recorded activity in this campaign at snapshot time"
              checked={watchedIncludeNoStatus}
              onChange={(v) =>
                form.setValue("include_no_status", v, { shouldDirty: true })
              }
              disabled={isSubmitting}
            />
            <FilterToggle
              label="Include clickers"
              description="Contacts who were clickers at snapshot time"
              checked={watchedIncludeClickers}
              onChange={setIncludeClickers}
              disabled={isSubmitting || watchedExcludeClickers}
              note={
                watchedExcludeClickers
                  ? "Conflicts with “Exclude clickers”"
                  : undefined
              }
            />
            <FilterToggle
              label="Exclude clickers"
              description="Explicitly remove anyone who clicked previously"
              checked={watchedExcludeClickers}
              onChange={setExcludeClickers}
              disabled={isSubmitting || watchedIncludeClickers}
              note={
                watchedIncludeClickers
                  ? "Conflicts with “Include clickers”"
                  : undefined
              }
            />
          </div>

          {/* Audience preview */}
          <Card>
            <CardContent className="grid gap-2 pt-6 text-sm">
              <div className="flex items-center justify-between">
                <div className="text-xs uppercase text-muted-foreground">
                  Stage audience
                </div>
                {audienceLoading ? (
                  <Loader2
                    className="size-4 animate-spin text-muted-foreground"
                    aria-hidden
                  />
                ) : null}
              </div>
              {audienceError ? (
                <p className="text-sm text-muted-foreground">
                  Could not preview audience.
                </p>
              ) : audiencePreview === null ? (
                <p className="text-sm text-muted-foreground">…</p>
              ) : (
                <>
                  <div className="text-2xl font-semibold tabular-nums">
                    {audiencePreview.count.toLocaleString()} contacts
                    <span className="ml-2 text-sm font-normal text-muted-foreground">
                      out of {audiencePreview.pool_size.toLocaleString()} frozen
                    </span>
                  </div>
                  <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
                    <span>
                      No-status:{" "}
                      <span className="font-mono tabular-nums text-foreground">
                        {audiencePreview.breakdown.no_status.toLocaleString()}
                      </span>
                    </span>
                    <span>
                      Clickers:{" "}
                      <span className="font-mono tabular-nums text-foreground">
                        {audiencePreview.breakdown.clickers.toLocaleString()}
                      </span>
                    </span>
                    <span>
                      Already opted out:{" "}
                      <span className="font-mono tabular-nums text-foreground">
                        {audiencePreview.breakdown.excluded_for_optout.toLocaleString()}
                      </span>{" "}
                      (excluded)
                    </span>
                  </div>
                  {audienceEmpty ? (
                    <p className="text-sm text-amber-700 dark:text-amber-400">
                      This stage has no audience. Adjust the filters or check
                      the parent campaign.
                    </p>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>
        </section>

        {isEdit && resultsCounters ? (
          <>
            <Separator />
            {/* ============ Results ============ */}
            <section className="grid gap-3">
              <div className="flex items-center justify-between gap-3">
                <SectionHeader title="Results" />
                <div className="flex items-center gap-2">
                  {onViewImportHistory ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={onViewImportHistory}
                    >
                      View import history →
                    </Button>
                  ) : null}
                  {onImportResults ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onImportResults}
                    >
                      Import results (CSV) →
                    </Button>
                  ) : null}
                </div>
              </div>
              <Card>
                <CardContent className="grid grid-cols-2 gap-3 pt-6 text-sm sm:grid-cols-5">
                  <ResultMetric
                    label="SMS sent"
                    value={resultsCounters.sms_count}
                  />
                  <ResultMetric
                    label="Delivered"
                    value={resultsCounters.delivered_count}
                  />
                  <ResultMetric
                    label="Opt-outs"
                    value={resultsCounters.opt_out_count}
                  />
                  <ResultMetric
                    label="Clickers"
                    value={resultsCounters.click_count}
                  />
                  <ResultMetric
                    label="Total cost"
                    value={`$${Number(resultsCounters.total_cost).toFixed(2)}`}
                    raw
                  />
                </CardContent>
              </Card>
            </section>
          </>
        ) : null}

        <Separator />

        {/* ============ Scheduling ============ */}
        <section className="grid gap-4">
          <SectionHeader title="Scheduling" />
          <FormField
            control={form.control}
            name="scheduled_at"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Scheduled send time (optional)</FormLabel>
                <FormControl>
                  <Input
                    type="datetime-local"
                    disabled={isSubmitting}
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  All times in Eastern Time (ET). Informational only — sends
                  are still triggered manually.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="notes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Notes (optional)</FormLabel>
                <FormControl>
                  <Textarea
                    rows={3}
                    placeholder="Anything to remember for this stage"
                    disabled={isSubmitting}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
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
            {isEdit ? "Save changes" : "Create stage"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// =============== Sub-components ===============

function SectionHeader({ title }: { title: string }) {
  return <h3 className="text-sm font-semibold text-foreground">{title}</h3>;
}

function ResultMetric({
  label,
  value,
  raw = false,
}: {
  label: string;
  value: number | string;
  raw?: boolean;
}) {
  return (
    <div>
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="font-mono text-lg tabular-nums">
        {raw
          ? String(value)
          : typeof value === "number"
            ? value.toLocaleString()
            : value}
      </div>
    </div>
  );
}

function FilterToggle({
  label,
  description,
  checked,
  onChange,
  disabled,
  note,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  note?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="grid gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
        {note ? (
          <span className="text-xs text-amber-700 dark:text-amber-400">
            {note}
          </span>
        ) : null}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}
