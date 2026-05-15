"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Loader2, Lock, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { MultiSelectPicker } from "@/components/multi-select-picker";
import { SegmentPicker } from "@/components/segments/segment-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { cn } from "@/lib/utils";

import {
  NONE,
  useCampaignFormState,
  type AudienceFilters,
  type CampaignFormState,
  type CampaignFormValues,
} from "./campaign-form-state";

// =============== Types ===============

type Status = "draft" | "active" | "paused" | "completed" | "archived";

type CampaignDetail = {
  id: number;
  slug: string;
  human_id: string | null;
  name: string;
  notes: string | null;
  brand_id: number;
  offer_id: number;
  routing_type_id: number | null;
  traffic_type_id: number | null;
  assigned_to_user_id: string | null;
  audience_segment_ids: number[];
  audience_contact_group_ids: number[];
  audience_filters: AudienceFilters;
  audience_cap: number | null;
  start_date: string | null;
  end_date: string | null;
  status: Status;
};

interface CreateModeProps {
  mode: "create";
}

interface EditModeProps {
  mode: "edit";
  campaignId: number;
}

export type CampaignEditorPageProps = CreateModeProps | EditModeProps;

const STATUS_COLOR: Record<Status, string> = {
  draft:
    "border-slate-200 bg-slate-100 text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200",
  active:
    "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  paused:
    "border-orange-200 bg-orange-100 text-orange-800 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-200",
  completed:
    "border-sky-200 bg-sky-100 text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200",
  archived:
    "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
};

const FILTER_DEFS: {
  key: keyof AudienceFilters;
  label: string;
  tooltip: string;
}[] = [
  {
    key: "include_no_status",
    label: "No-status",
    tooltip: "People in segments without recorded opt-in or click activity",
  },
  {
    key: "include_opt_in",
    label: "Opt-in",
    tooltip: "People who explicitly opted in",
  },
  {
    key: "include_clickers",
    label: "Clickers",
    tooltip: "People who clicked a link in a past send",
  },
  {
    key: "include_not_clicked",
    label: "Not-clicked",
    tooltip: "People uploaded but with no click recorded",
  },
];

// =============== Public component ===============

export function CampaignEditorPage(props: CampaignEditorPageProps) {
  if (props.mode === "create") {
    return <Inner mode="create" />;
  }
  return <EditModeLoader campaignId={props.campaignId} />;
}

// =============== Edit-mode async loader ===============

function EditModeLoader({ campaignId }: { campaignId: number }) {
  const detailApi = useApiCall<CampaignDetail>();
  const [data, setData] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      setError("Invalid campaign id");
      return;
    }
    let cancelled = false;
    (async () => {
      const r = await detailApi.execute(`/api/campaigns/${campaignId}`);
      if (cancelled) return;
      if (r.ok) setData(r.data);
      else setError(r.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId, detailApi.execute]);

  if (error) {
    return (
      <div className="space-y-4">
        <BackHeader title="Edit campaign" />
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">{error}</p>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-4">
        <BackHeader title="Edit campaign" />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const initialValues: CampaignFormValues = {
    name: data.name,
    human_id: data.human_id ?? "",
    notes: data.notes ?? "",
    brand_id: data.brand_id,
    offer_id: data.offer_id,
    routing_type_id: data.routing_type_id,
    traffic_type_id: data.traffic_type_id,
    assigned_to_user_id: data.assigned_to_user_id,
    audience_segment_ids: data.audience_segment_ids ?? [],
    audience_contact_group_ids: data.audience_contact_group_ids ?? [],
    audience_filters: {
      include_no_status: data.audience_filters?.include_no_status ?? true,
      include_opt_in: data.audience_filters?.include_opt_in ?? false,
      include_clickers: data.audience_filters?.include_clickers ?? false,
      include_not_clicked: data.audience_filters?.include_not_clicked ?? true,
    },
    audience_cap: data.audience_cap ?? null,
    start_date: data.start_date ?? "",
    end_date: data.end_date ?? "",
  };

  return (
    <Inner
      mode="edit"
      campaignId={data.id}
      campaignSlug={data.slug}
      campaignName={data.name}
      currentStatus={data.status}
      initialValues={initialValues}
    />
  );
}

// =============== Inner editor ===============

interface InnerProps {
  mode: "create" | "edit";
  campaignId?: number;
  campaignSlug?: string;
  campaignName?: string;
  currentStatus?: Status;
  initialValues?: CampaignFormValues;
}

function Inner({
  mode,
  campaignId,
  campaignSlug,
  campaignName,
  currentStatus,
  initialValues,
}: InnerProps) {
  const router = useRouter();
  const isEdit = mode === "edit";

  const createApi = useApiCall<{ id: number; audience_snapshot_count: number }>();
  const activateApi = useApiCall<{ id: number; audience_snapshot_count: number }>();
  const updateApi = useApiCall<{ id: number }>();

  function goBack() {
    if (isEdit && campaignId) {
      router.push(`/campaigns/${campaignId}`);
    } else {
      router.push("/campaigns");
    }
  }

  async function handleCreateDraft(values: CampaignFormValues) {
    const result = await createApi.execute("/api/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildCreateBody(values, true)),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't save draft");
      return;
    }
    toast.success("Draft saved");
    router.push(`/campaigns/${result.data.id}`);
  }

  async function handleCreateActivate(values: CampaignFormValues) {
    const result = await activateApi.execute("/api/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildCreateBody(values, false)),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't activate campaign");
      return;
    }
    const count = result.data.audience_snapshot_count.toLocaleString();
    toast.success(`Campaign activated — ${count} contacts in audience pool`);
    router.push(`/campaigns/${result.data.id}`);
  }

  async function handleEditSubmit(values: CampaignFormValues) {
    if (!campaignId) return;
    const body = buildPatchBody(values);
    if (currentStatus && currentStatus !== "draft") {
      delete body.audience_segment_ids;
      delete body.audience_contact_group_ids;
      delete body.audience_filters;
      delete body.audience_cap;
    }
    const result = await updateApi.execute(`/api/campaigns/${campaignId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't save changes");
      return;
    }
    toast.success("Campaign saved");
    router.push(`/campaigns/${campaignId}`);
  }

  const state = useCampaignFormState({
    mode,
    initialValues,
    currentStatus,
    onSubmitDraft: isEdit ? handleEditSubmit : handleCreateDraft,
    onSubmitActivate: isEdit ? handleEditSubmit : handleCreateActivate,
    onCancel: goBack,
    isSubmittingDraft: createApi.isLoading,
    isSubmittingActivate: isEdit ? updateApi.isLoading : activateApi.isLoading,
  });

  const {
    form,
    activateReady,
    draftReady,
    activateBlockedReason,
    anySubmitting,
    isSubmittingDraft,
    isSubmittingActivate,
    handleDraftClick,
    handleActivateClick,
  } = state;

  const displayStatus: Status = isEdit ? currentStatus ?? "draft" : "draft";
  const headerTitle = isEdit
    ? campaignName ?? "Edit campaign"
    : "New Campaign";

  return (
    <Form {...form}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (isEdit) void handleActivateClick();
          else if (activateReady) void handleActivateClick();
          else if (draftReady) void handleDraftClick();
        }}
        className="space-y-4"
        noValidate
      >
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/campaigns"
              aria-label="All campaigns"
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-5" />
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight">
              {headerTitle}
            </h1>
            {isEdit ? (
              <Badge
                className={cn("capitalize", STATUS_COLOR[displayStatus])}
              >
                {displayStatus}
              </Badge>
            ) : null}
            {campaignSlug ? (
              <span className="font-mono text-xs text-muted-foreground">
                {campaignSlug}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={goBack}
              disabled={anySubmitting}
            >
              Cancel
            </Button>
            {isEdit ? (
              <Button
                type="button"
                size="sm"
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
                  size="sm"
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
                  size="sm"
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
        </div>

        {/* Body */}
        <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
          <div className="grid min-w-0 gap-4">
            <SetupCard state={state} />
            <AudienceCard state={state} />
          </div>
          <aside className="grid gap-3">
            <AudienceCompositionPanel state={state} />
            <NotesCard state={state} />
            {!isEdit && activateBlockedReason ? (
              <p className="text-xs text-muted-foreground">
                {activateBlockedReason}
              </p>
            ) : null}
          </aside>
        </div>
      </form>
    </Form>
  );
}

// =============== Setup card ===============

function SetupCard({ state }: { state: CampaignFormState }) {
  const {
    form,
    brands,
    offers,
    routingTypes,
    trafficTypes,
    members,
    anySubmitting,
    dateError,
  } = state;

  return (
    <Card>
      <CardHeader className="border-b py-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Setup
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 p-4">
        <div className="grid gap-3 md:grid-cols-3">
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
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {brands.map((b) => (
                      <SelectItem key={b.id} value={String(b.id)}>
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="size-2 rounded-full"
                            style={{
                              backgroundColor: b.color ?? "#64748B",
                            }}
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
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {offers.map((o) => (
                      <SelectItem key={o.id} value={String(o.id)}>
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="size-2 rounded-full"
                            style={{
                              backgroundColor: o.color ?? "#64748B",
                            }}
                          />
                          <span>{o.name}</span>
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
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="routing_type_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Routing</FormLabel>
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
                <FormLabel>Traffic</FormLabel>
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
          <FormField
            control={form.control}
            name="assigned_to_user_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Assigned</FormLabel>
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
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="start_date"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Start date</FormLabel>
                <FormControl>
                  <Input type="date" disabled={anySubmitting} {...field} />
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
                  <Input type="date" disabled={anySubmitting} {...field} />
                </FormControl>
                {dateError ? (
                  <p className="text-xs text-destructive">{dateError}</p>
                ) : null}
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// =============== Audience card ===============

function AudienceCard({ state }: { state: CampaignFormState }) {
  const {
    form,
    segments,
    contactGroups,
    contactGroupsLoading,
    audienceLocked,
    anySubmitting,
    watchedSegments,
    watchedContactGroups,
    watchedFilters,
    setFilter,
  } = state;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 border-b py-2">
        <Users className="size-3.5 text-muted-foreground" aria-hidden />
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Audience
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 p-4">
        {audienceLocked ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs dark:border-amber-900 dark:bg-amber-950/40">
            <Lock
              className="size-3.5 mt-0.5 text-amber-700 dark:text-amber-300"
              aria-hidden
            />
            <div className="text-amber-800 dark:text-amber-200">
              Audience is locked once a campaign is activated.
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-3">
          <div className="grid gap-1.5">
            <Label>
              Segments
              <span aria-hidden className="text-destructive ml-0.5">
                *
              </span>
            </Label>
            <SegmentPicker
              segments={segments}
              value={watchedSegments}
              onChange={(next) =>
                form.setValue("audience_segment_ids", next, {
                  shouldDirty: true,
                })
              }
              disabled={audienceLocked || anySubmitting}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Contact groups</Label>
            <MultiSelectPicker
              options={contactGroups.map((g) => ({
                id: g.id,
                label: g.name,
                color: g.color,
              }))}
              value={watchedContactGroups}
              onChange={(next) =>
                form.setValue(
                  "audience_contact_group_ids",
                  next as number[],
                  { shouldDirty: true },
                )
              }
              placeholder="Select groups"
              selectedLabel={(n) =>
                `${n} group${n === 1 ? "" : "s"} selected`
              }
              isLoading={contactGroupsLoading && contactGroups.length === 0}
              disabled={audienceLocked || anySubmitting}
              emptyMessage="No contact groups yet."
              searchPlaceholder="Search groups…"
            />
          </div>
          <FormField
            control={form.control}
            name="audience_cap"
            render={({ field }) => (
              <FormItem className="grid gap-1.5">
                <FormLabel>Audience cap</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    placeholder="No cap"
                    disabled={audienceLocked || anySubmitting}
                    value={field.value ?? ""}
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      if (v === "") {
                        field.onChange(null);
                        return;
                      }
                      const n = Number(v);
                      field.onChange(
                        Number.isFinite(n) && n > 0 ? Math.floor(n) : null,
                      );
                    }}
                  />
                </FormControl>
                <FormDescription className="text-xs">
                  Blank = full audience. Random sample frozen at activation.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Filter chips */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Filters:</span>
          {FILTER_DEFS.map((f) => {
            const active = watchedFilters[f.key];
            return (
              <button
                key={f.key}
                type="button"
                title={f.tooltip}
                onClick={() => setFilter(f.key, !active)}
                disabled={audienceLocked || anySubmitting}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                  active
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background text-muted-foreground hover:bg-muted",
                  (audienceLocked || anySubmitting) &&
                    "cursor-not-allowed opacity-60",
                )}
              >
                {f.label}
              </button>
            );
          })}
          <span className="text-xs text-muted-foreground">
            · Opt-outs always excluded
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// =============== Notes card (right rail) ===============

function NotesCard({ state }: { state: CampaignFormState }) {
  const { form, anySubmitting } = state;
  return (
    <Card>
      <CardHeader className="border-b py-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Notes
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3">
        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <Textarea
                  rows={4}
                  placeholder="Context, links, anything worth remembering…"
                  disabled={anySubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </CardContent>
    </Card>
  );
}

// =============== Audience composition panel ===============

function AudienceCompositionPanel({ state }: { state: CampaignFormState }) {
  const {
    hasAudienceSource,
    previewCount,
    previewTotalMatching,
    previewFromSegments,
    previewFromGroups,
    previewOverlap,
    previewExcludedOptOut,
    previewError,
    previewLoading,
    watchedSegments,
    watchedContactGroups,
    watchedCap,
  } = state;

  const hasSegments = watchedSegments.length > 0;
  const hasGroups = watchedContactGroups.length > 0;
  const showOverlap = hasSegments && hasGroups;
  const capActive =
    watchedCap !== null &&
    previewTotalMatching !== null &&
    watchedCap < previewTotalMatching;
  const sampledPct =
    capActive && previewTotalMatching !== null && previewTotalMatching > 0
      ? Math.round(((previewCount ?? 0) / previewTotalMatching) * 100)
      : null;

  return (
    <Card>
      <CardHeader className="border-b py-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Audience preview
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 p-4 text-sm">
        {!hasAudienceSource ? (
          <p className="text-muted-foreground">
            Pick segments or contact groups to see your reach.
          </p>
        ) : previewError ? (
          <p className="text-muted-foreground">
            Could not preview audience — fix any issues above.
          </p>
        ) : previewCount === null ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Calculating…
          </div>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <div className="text-2xl font-semibold tabular-nums">
                  {previewCount.toLocaleString()}
                </div>
                <div className="text-xs text-muted-foreground">
                  {previewCount === 1 ? "contact" : "contacts"}
                </div>
              </div>
              {previewLoading ? (
                <Loader2
                  className="size-4 animate-spin text-muted-foreground"
                  aria-hidden
                />
              ) : null}
            </div>

            <div className="grid gap-1.5 border-t pt-3 text-xs">
              {hasSegments && previewFromSegments !== null ? (
                <BreakdownRow
                  label="From segments"
                  value={previewFromSegments}
                />
              ) : null}
              {hasGroups && previewFromGroups !== null ? (
                <BreakdownRow
                  label="From contact groups"
                  value={previewFromGroups}
                />
              ) : null}
              {showOverlap && previewOverlap !== null ? (
                <BreakdownRow
                  label="In both"
                  value={previewOverlap}
                  muted
                />
              ) : null}
              {previewExcludedOptOut !== null &&
              previewExcludedOptOut > 0 ? (
                <BreakdownRow
                  label="Opt-outs excluded"
                  value={previewExcludedOptOut}
                  muted
                />
              ) : null}
            </div>

            {capActive && previewTotalMatching !== null ? (
              <div className="grid gap-1.5 border-t pt-3 text-xs">
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>
                    Cap:{" "}
                    <span className="font-mono tabular-nums text-foreground">
                      {(previewCount ?? 0).toLocaleString()}
                    </span>{" "}
                    of{" "}
                    <span className="font-mono tabular-nums text-foreground">
                      {previewTotalMatching.toLocaleString()}
                    </span>
                  </span>
                  {sampledPct !== null ? (
                    <span className="tabular-nums">{sampledPct}%</span>
                  ) : null}
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-foreground transition-all"
                    style={{ width: `${sampledPct ?? 0}%` }}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Random sample frozen at activation.
                </p>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BreakdownRow({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: number;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className={cn(muted ? "text-muted-foreground" : undefined)}>
        {label}
      </span>
      <span
        className={cn(
          "font-mono tabular-nums",
          muted ? "text-muted-foreground" : undefined,
        )}
      >
        {value.toLocaleString()}
      </span>
    </div>
  );
}

// =============== Helpers ===============

function BackHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-3">
      <Link
        href="/campaigns"
        aria-label="All campaigns"
        className="text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-5" />
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
    </div>
  );
}

function buildCreateBody(
  values: CampaignFormValues,
  saveAsDraft: boolean,
): Record<string, unknown> {
  return {
    name: values.name.trim(),
    human_id: values.human_id.trim() ? values.human_id.trim() : undefined,
    notes: values.notes.trim() ? values.notes.trim() : undefined,
    brand_id: values.brand_id,
    offer_id: values.offer_id,
    routing_type_id: values.routing_type_id,
    traffic_type_id: values.traffic_type_id,
    assigned_to_user_id: values.assigned_to_user_id,
    audience_segment_ids: values.audience_segment_ids,
    audience_contact_group_ids: values.audience_contact_group_ids,
    audience_filters: values.audience_filters,
    audience_cap: values.audience_cap,
    start_date: values.start_date || undefined,
    end_date: values.end_date || undefined,
    save_as_draft: saveAsDraft,
  };
}

function buildPatchBody(values: CampaignFormValues): Record<string, unknown> {
  return {
    name: values.name.trim(),
    human_id: values.human_id.trim() ? values.human_id.trim() : "",
    notes: values.notes.trim() ? values.notes.trim() : "",
    brand_id: values.brand_id,
    offer_id: values.offer_id,
    routing_type_id: values.routing_type_id,
    traffic_type_id: values.traffic_type_id,
    assigned_to_user_id: values.assigned_to_user_id,
    audience_segment_ids: values.audience_segment_ids,
    audience_contact_group_ids: values.audience_contact_group_ids,
    audience_filters: values.audience_filters,
    audience_cap: values.audience_cap,
    start_date: values.start_date || undefined,
    end_date: values.end_date || undefined,
  };
}
