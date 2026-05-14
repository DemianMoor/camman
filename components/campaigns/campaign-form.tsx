"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Lock, Search } from "lucide-react";
import { useForm } from "react-hook-form";

import { useAuth } from "@/components/protected/auth-context";
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
import { Label } from "@/components/ui/label";
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
import { useApiCall } from "@/lib/hooks/use-api-call";
import { cn } from "@/lib/utils";

// =============== Types ===============

type Info = { id: number; name: string; color: string | null };
type Offer = Info & { payout_model: string; payout_cpa: string | null };
type SegmentInfo = {
  id: number;
  name: string;
  segment_id: string;
  stats: { total_count: number };
  active_rules_count?: number;
};
type Member = {
  id: string;
  email: string | null;
  display_name: string | null;
};

export interface AudienceFilters {
  include_no_status: boolean;
  include_opt_in: boolean;
  include_clickers: boolean;
  include_not_clicked: boolean;
}

export interface CampaignFormValues {
  name: string;
  human_id: string;
  notes: string;
  brand_id: number | null;
  offer_id: number | null;
  routing_type_id: number | null;
  traffic_type_id: number | null;
  assigned_to_user_id: string | null;
  audience_segment_ids: number[];
  audience_filters: AudienceFilters;
  start_date: string;
  end_date: string;
}

export interface CampaignFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<CampaignFormValues>;
  // Edit-mode only: gates the audience section as read-only when the
  // campaign has moved past draft.
  currentStatus?: string;
  onSubmitDraft: (values: CampaignFormValues) => Promise<void>;
  onSubmitActivate: (values: CampaignFormValues) => Promise<void>;
  onCancel: () => void;
  isSubmittingDraft: boolean;
  isSubmittingActivate: boolean;
}

const NONE = "__none__";
const DEFAULT_FILTERS: AudienceFilters = {
  include_no_status: true,
  include_opt_in: false,
  include_clickers: false,
  include_not_clicked: true,
};

// =============== Component ===============

export function CampaignForm({
  mode,
  initialValues,
  currentStatus,
  onSubmitDraft,
  onSubmitActivate,
  onCancel,
  isSubmittingDraft,
  isSubmittingActivate,
}: CampaignFormProps) {
  const isEdit = mode === "edit";
  const audienceLocked = isEdit && currentStatus !== undefined && currentStatus !== "draft";
  const { auth } = useAuth();

  // Reference data
  const brandsApi = useApiCall<{ data: Info[] }>();
  const offersApi = useApiCall<{ data: Offer[] }>();
  const routingApi = useApiCall<{ data: Info[] }>();
  const trafficApi = useApiCall<{ data: Info[] }>();
  const segmentsApi = useApiCall<{ data: SegmentInfo[] }>();
  const membersApi = useApiCall<{ data: Member[] }>();
  const [brands, setBrands] = useState<Info[]>([]);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [routingTypes, setRoutingTypes] = useState<Info[]>([]);
  const [trafficTypes, setTrafficTypes] = useState<Info[]>([]);
  const [segments, setSegments] = useState<SegmentInfo[]>([]);
  const [members, setMembers] = useState<Member[]>([]);

  useEffect(() => {
    (async () => {
      const r = await brandsApi.execute(
        "/api/brands/list?pageSize=200",
      );
      if (r.ok) setBrands(r.data.data.filter((b) => true));
    })();
  }, [brandsApi.execute]);
  useEffect(() => {
    (async () => {
      const r = await offersApi.execute("/api/offers/list?pageSize=200");
      if (r.ok) setOffers(r.data.data);
    })();
  }, [offersApi.execute]);
  useEffect(() => {
    (async () => {
      const r = await routingApi.execute(
        "/api/routing-types/list?pageSize=200",
      );
      if (r.ok) setRoutingTypes(r.data.data);
    })();
  }, [routingApi.execute]);
  useEffect(() => {
    (async () => {
      const r = await trafficApi.execute(
        "/api/traffic-types/list?pageSize=200",
      );
      if (r.ok) setTrafficTypes(r.data.data);
    })();
  }, [trafficApi.execute]);
  useEffect(() => {
    (async () => {
      const r = await segmentsApi.execute(
        "/api/segments/list?pageSize=500&sortBy=name&sortDir=asc",
      );
      if (r.ok) setSegments(r.data.data);
    })();
  }, [segmentsApi.execute]);
  useEffect(() => {
    (async () => {
      const r = await membersApi.execute("/api/members");
      if (r.ok) setMembers(r.data.data);
    })();
  }, [membersApi.execute]);

  // RHF setup
  const form = useForm<CampaignFormValues>({
    defaultValues: {
      name: initialValues?.name ?? "",
      human_id: initialValues?.human_id ?? "",
      notes: initialValues?.notes ?? "",
      brand_id: initialValues?.brand_id ?? null,
      offer_id: initialValues?.offer_id ?? null,
      routing_type_id: initialValues?.routing_type_id ?? null,
      traffic_type_id: initialValues?.traffic_type_id ?? null,
      assigned_to_user_id:
        initialValues?.assigned_to_user_id ?? auth?.user.id ?? null,
      audience_segment_ids: initialValues?.audience_segment_ids ?? [],
      audience_filters: initialValues?.audience_filters ?? DEFAULT_FILTERS,
      start_date: initialValues?.start_date ?? "",
      end_date: initialValues?.end_date ?? "",
    },
  });

  // Watched fields for live enablement + audience preview
  const watchedName = form.watch("name");
  const watchedBrandId = form.watch("brand_id");
  const watchedOfferId = form.watch("offer_id");
  const watchedSegments = form.watch("audience_segment_ids");
  const watchedFilters = form.watch("audience_filters");
  const watchedStart = form.watch("start_date");
  const watchedEnd = form.watch("end_date");

  // Audience preview, debounced. Tracks its own cancel signal so a fast
  // toggle doesn't apply a stale count.
  const previewApi = useApiCall<{ count: number }>();
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const segmentsKey = watchedSegments.join(",");
  const filtersKey = JSON.stringify(watchedFilters);

  useEffect(() => {
    if (watchedSegments.length === 0) {
      setPreviewCount(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setPreviewLoading(true);
      const result = await previewApi.execute(
        "/api/campaigns/audience-preview",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audience_segment_ids: watchedSegments,
            audience_filters: watchedFilters,
          }),
        },
      );
      if (cancelled) return;
      setPreviewLoading(false);
      if (result.ok) {
        setPreviewCount(result.data.count);
        setPreviewError(null);
      } else {
        setPreviewError(result.error);
        setPreviewCount(null);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // segmentsKey / filtersKey collapse the array+object identity to stable
    // primitives so this effect only re-runs on actual change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentsKey, filtersKey, previewApi.execute]);

  // Date sanity (purely client-side hint; the server doesn't refuse
  // end<start because either field can be null).
  const dateError =
    watchedStart && watchedEnd && watchedEnd < watchedStart
      ? "End date can't be before start date"
      : null;

  // Drafts are a scratchpad — always saveable. Activation requires the
  // launch invariants (name + brand + offer + ≥1 segment).
  const draftReady = !dateError;
  const activateReady =
    !!watchedName.trim() &&
    watchedBrandId !== null &&
    watchedOfferId !== null &&
    watchedSegments.length > 0 &&
    !dateError;
  const activateBlockedReason = dateError
    ? dateError
    : !activateReady
      ? "Fill in name, brand, offer, and at least one segment to activate."
      : null;
  const anySubmitting = isSubmittingDraft || isSubmittingActivate;

  // Segment search (the list can be long)
  const [segmentSearch, setSegmentSearch] = useState("");
  const filteredSegments = useMemo(() => {
    const q = segmentSearch.trim().toLowerCase();
    if (!q) return segments;
    return segments.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.segment_id.toLowerCase().includes(q),
    );
  }, [segmentSearch, segments]);

  function toggleSegment(id: number) {
    const current = form.getValues("audience_segment_ids");
    if (current.includes(id)) {
      form.setValue(
        "audience_segment_ids",
        current.filter((x) => x !== id),
        { shouldDirty: true },
      );
    } else {
      form.setValue("audience_segment_ids", [...current, id], {
        shouldDirty: true,
      });
    }
  }

  function setFilter<K extends keyof AudienceFilters>(
    key: K,
    value: boolean,
  ) {
    form.setValue(
      "audience_filters",
      { ...form.getValues("audience_filters"), [key]: value },
      { shouldDirty: true },
    );
  }

  async function handleDraftClick() {
    const values = form.getValues();
    await onSubmitDraft(values);
  }
  async function handleActivateClick() {
    const values = form.getValues();
    await onSubmitActivate(values);
  }

  return (
    <Form {...form}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          // Default submit (Enter key) runs the primary action.
          if (isEdit) void handleActivateClick();
          else if (activateReady) void handleActivateClick();
          else if (draftReady) void handleDraftClick();
        }}
        className="grid gap-6"
        noValidate
      >
        {/* ============ Identity ============ */}
        <section className="grid gap-4">
          <SectionHeader title="Identity" />
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Name</FormLabel>
                <FormControl>
                  <Input
                    placeholder="e.g. Q1 New Customer Push"
                    disabled={anySubmitting}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="human_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Human ID</FormLabel>
                <FormControl>
                  <Input
                    placeholder="Q1-PROMO-2026"
                    disabled={anySubmitting}
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  Letters, digits, hyphens, underscores. Useful when this
                  campaign maps to an external system.
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
                <FormLabel>Notes</FormLabel>
                <FormControl>
                  <Textarea
                    rows={3}
                    placeholder="Anything worth remembering — context, links to specs, etc."
                    disabled={anySubmitting}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </section>

        <Separator />

        {/* ============ Core ============ */}
        <section className="grid gap-4">
          <SectionHeader title="Core" />
          <FormField
            control={form.control}
            name="brand_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Brand</FormLabel>
                <Select
                  value={field.value === null ? "" : String(field.value)}
                  onValueChange={(v) => field.onChange(Number(v))}
                  disabled={anySubmitting}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a brand" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
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
            name="offer_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel required>Offer</FormLabel>
                <Select
                  value={field.value === null ? "" : String(field.value)}
                  onValueChange={(v) => field.onChange(Number(v))}
                  disabled={anySubmitting}
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
                          <span>{o.name}</span>
                          <span className="text-xs text-muted-foreground">
                            ·{" "}
                            {o.payout_model === "cpa"
                              ? `$${o.payout_cpa ?? "0"} CPA`
                              : "revshare"}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="routing_type_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Routing type</FormLabel>
                  <Select
                    value={field.value === null ? NONE : String(field.value)}
                    onValueChange={(v) =>
                      field.onChange(v === NONE ? null : Number(v))
                    }
                    disabled={anySubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE}>None</SelectItem>
                      {routingTypes.map((r) => (
                        <SelectItem key={r.id} value={String(r.id)}>
                          {r.name}
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
              name="traffic_type_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Traffic type</FormLabel>
                  <Select
                    value={field.value === null ? NONE : String(field.value)}
                    onValueChange={(v) =>
                      field.onChange(v === NONE ? null : Number(v))
                    }
                    disabled={anySubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE}>None</SelectItem>
                      {trafficTypes.map((t) => (
                        <SelectItem key={t.id} value={String(t.id)}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <FormField
            control={form.control}
            name="assigned_to_user_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Assigned to</FormLabel>
                <Select
                  value={field.value === null ? NONE : field.value}
                  onValueChange={(v) =>
                    field.onChange(v === NONE ? null : v)
                  }
                  disabled={anySubmitting}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Unassigned" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NONE}>Unassigned</SelectItem>
                    {members.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.display_name ?? m.email ?? m.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  Defaults to you. Reassign later from the actions menu
                  (requires manager+).
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </section>

        <Separator />

        {/* ============ Audience ============ */}
        <section className="grid gap-4">
          <SectionHeader title="Audience" />
          {audienceLocked ? (
            <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
              <Lock
                className="size-4 mt-0.5 text-amber-700 dark:text-amber-300"
                aria-hidden
              />
              <div className="text-amber-800 dark:text-amber-200">
                Audience is locked once a campaign is activated. To change
                the audience, create a new campaign.
              </div>
            </div>
          ) : null}

          {/* Segments
              TODO: this inline scrollable list with search predates
              <MultiSelectPicker>. It scales fine (already has search +
              scroll), but a future cleanup could migrate to the shared
              picker for UI consistency. The current pattern is
              "visible-by-default" rather than popover-collapsed, which
              suits the campaign builder's main step better. */}
          <div className="grid gap-2">
            <Label>
              Segments
              <span aria-hidden className="text-destructive ml-0.5">*</span>
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                (1+ required to activate)
              </span>
            </Label>
            <div className="relative">
              <Search
                className="absolute left-3 top-2.5 size-4 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={segmentSearch}
                onChange={(e) => setSegmentSearch(e.target.value)}
                placeholder="Search segments…"
                disabled={audienceLocked || anySubmitting}
                className="pl-9"
              />
            </div>
            <div className="max-h-56 overflow-y-auto rounded-md border bg-background">
              {filteredSegments.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">
                  {segments.length === 0
                    ? "No segments available."
                    : "No segments match your search."}
                </p>
              ) : (
                <ul className="divide-y">
                  {filteredSegments.map((s) => {
                    const selected = watchedSegments.includes(s.id);
                    return (
                      <li key={s.id}>
                        <button
                          type="button"
                          disabled={audienceLocked || anySubmitting}
                          onClick={() => toggleSegment(s.id)}
                          className={cn(
                            "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50",
                            selected && "bg-muted/30",
                            (audienceLocked || anySubmitting) &&
                              "cursor-not-allowed opacity-60",
                          )}
                        >
                          <span className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selected}
                              readOnly
                              tabIndex={-1}
                              className="size-4 cursor-pointer"
                            />
                            <span className="font-medium">{s.name}</span>
                            <span className="font-mono text-xs text-muted-foreground">
                              {s.segment_id}
                            </span>
                            {(s.active_rules_count ?? 0) > 0 ? (
                              <span
                                className="rounded-full border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-violet-700 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-200"
                                title={`This segment uses ${s.active_rules_count} audience rule${s.active_rules_count === 1 ? "" : "s"} combined with its manual membership. The audience count reflects the rule-filtered+manual UNION.`}
                              >
                                Has rules
                              </span>
                            ) : null}
                          </span>
                          <Badge variant="secondary">
                            {s.stats.total_count.toLocaleString()}
                          </Badge>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {watchedSegments.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {watchedSegments.length} segment
                {watchedSegments.length === 1 ? "" : "s"} selected
              </p>
            ) : null}
          </div>

          {/* Filter toggles */}
          <div className="grid gap-3">
            <FilterToggle
              label="Include no-status contacts"
              description="People in your segments without recorded opt-in or click activity"
              checked={watchedFilters.include_no_status}
              onChange={(v) => setFilter("include_no_status", v)}
              disabled={audienceLocked || anySubmitting}
            />
            <FilterToggle
              label="Include opt-in contacts"
              description="People who explicitly opted in"
              checked={watchedFilters.include_opt_in}
              onChange={(v) => setFilter("include_opt_in", v)}
              disabled={audienceLocked || anySubmitting}
            />
            <FilterToggle
              label="Include clickers"
              description="People who clicked a link in a past send"
              checked={watchedFilters.include_clickers}
              onChange={(v) => setFilter("include_clickers", v)}
              disabled={audienceLocked || anySubmitting}
            />
            <FilterToggle
              label="Include not-clicked contacts"
              description="People uploaded but with no click recorded"
              checked={watchedFilters.include_not_clicked}
              onChange={(v) => setFilter("include_not_clicked", v)}
              disabled={audienceLocked || anySubmitting}
            />
            <p className="text-xs text-muted-foreground">
              Opt-outs are always excluded from sends — this is non-overridable.
            </p>
          </div>

          {/* Audience preview */}
          <Card>
            <CardContent className="flex items-center justify-between gap-3 pt-6 text-sm">
              <div>
                <div className="text-xs uppercase text-muted-foreground">
                  Estimated audience
                </div>
                {watchedSegments.length === 0 ? (
                  <div className="text-muted-foreground">
                    0 contacts (select segments to see your reach)
                  </div>
                ) : previewError ? (
                  <div className="text-sm text-muted-foreground">
                    Could not preview audience — fix any issues above
                  </div>
                ) : (
                  <div className="text-2xl font-semibold tabular-nums">
                    {previewCount !== null
                      ? `${previewCount.toLocaleString()} contacts`
                      : "—"}
                  </div>
                )}
              </div>
              {previewLoading ? (
                <Loader2
                  className="size-4 animate-spin text-muted-foreground"
                  aria-hidden
                />
              ) : null}
            </CardContent>
          </Card>
        </section>

        <Separator />

        {/* ============ Schedule ============ */}
        <section className="grid gap-4">
          <SectionHeader title="Schedule" />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="start_date"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Start date</FormLabel>
                  <FormControl>
                    <Input
                      type="date"
                      disabled={anySubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="end_date"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>End date</FormLabel>
                  <FormControl>
                    <Input
                      type="date"
                      disabled={anySubmitting}
                      {...field}
                    />
                  </FormControl>
                  {dateError ? (
                    <p className="text-sm text-destructive">{dateError}</p>
                  ) : null}
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </section>

        {/* ============ Actions ============ */}
        <div className="grid gap-2 pt-2">
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={anySubmitting}
            >
              Cancel
            </Button>
            {isEdit ? (
              <Button
                type="button"
                onClick={handleActivateClick}
                disabled={anySubmitting}
              >
                {isSubmittingActivate ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : null}
                Save changes
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleDraftClick}
                  disabled={!draftReady || anySubmitting}
                >
                  {isSubmittingDraft ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : null}
                  Save as draft
                </Button>
                <Button
                  type="button"
                  onClick={handleActivateClick}
                  disabled={!activateReady || anySubmitting}
                  title={activateBlockedReason ?? undefined}
                >
                  {isSubmittingActivate ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : null}
                  Activate
                </Button>
              </>
            )}
          </div>
          {!isEdit ? (
            <p className="text-right text-xs text-muted-foreground">
              Draft saves without sending. Activate freezes the audience and
              prepares the campaign for stage management.
            </p>
          ) : null}
        </div>
      </form>
    </Form>
  );
}

// =============== Sub-components ===============

function SectionHeader({ title }: { title: string }) {
  return <h3 className="text-sm font-semibold text-foreground">{title}</h3>;
}

function FilterToggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="grid gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}
