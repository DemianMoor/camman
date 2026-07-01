"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Loader2, RotateCcw } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import {
  CreativePickerDialog,
  type PickerCreative,
} from "@/components/campaigns/creative-picker-dialog";
import {
  CreativeForm,
  type CreativeFormValues,
} from "@/components/creatives/creative-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CopyableId } from "@/components/ui/copyable-id";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import { toastApiError } from "@/lib/api/toast-error";
import { formatInTimeZone } from "date-fns-tz";

import {
  campaignLocalInputToUtcIso,
  CAMPAIGN_TIMEZONE,
} from "@/lib/campaign-timezone";
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
import { isEntityAvailable } from "@/lib/feature-flags";
import { isOutsideSendWindow } from "@/lib/quiet-hours";
import { isScheduledAtInPast } from "@/lib/sends/schedule-guard";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { formatPhoneInternational } from "@/lib/phone-validation";
import { buildStageSms } from "@/lib/sends/stage-sms";
import {
  appendParamName,
  appendRawValue,
  hasUrlParam,
  removeRawValue,
  removeUrlParam,
} from "@/lib/stage-url";
import { formatStageTrackingId } from "@/lib/tracking-id-format";
import { cn } from "@/lib/utils";

// =============== Types ===============

export interface StageFormValues {
  label: string;
  creative_id: number | null;
  sms_provider_id: number | null;
  provider_phone_id: number | null;
  sales_page_label: string;
  // Optional URLs. short_url is rendered into the SMS preview on its
  // own line between creative text and stop text; full_url is tracking
  // metadata only (not sent).
  short_url: string;
  full_url: string;
  // Selected UTM tag ids (ordered) that append &<label>=<value_source> to
  // full_url. Persisted on the stage so the selection round-trips on edit.
  utm_tag_ids: number[];
  // When true, full_url is auto-derived (sales page + offer postfix +
  // tracking ID + UTM tags) and the server rebuilds it with the real
  // tracking ID on save. Set false the moment the operator hand-edits the
  // field; flipped back on by "Reset to generated".
  full_url_auto: boolean;
  stop_text: string;
  include_no_status: boolean;
  include_clickers: boolean;
  exclude_clickers: boolean;
  scheduled_at: string;
  notes: string;
}

type UtmTag = {
  id: number;
  tag_id: string;
  label: string;
  value_source: string;
  color: string | null;
};

type Creative = {
  id: number;
  slug: string;
  text: string;
  status: string;
  // Cached spam score, surfaced by the list endpoint. Null when the
  // creative hasn't been scored yet.
  spam_score: number | null;
  spam_verdict: "spam" | "not_spam" | null;
};
type Provider = {
  id: number;
  name: string;
  color: string | null;
  status: string;
  // Auto-send window bounds (minute-of-day ET); null = default window. Used to
  // warn when a scheduled time falls in this provider's quiet hours.
  send_window_weekday_start: number | null;
  send_window_weekday_end: number | null;
  send_window_weekend_start: number | null;
  send_window_weekend_end: number | null;
};
type ProviderPhone = {
  id: number;
  phone_number: string;
  cost_per_sms: string;
  status: string;
};
type SalesPage = { label: string; url: string };
type BrandInfo = {
  id: number;
  name: string;
  color: string | null;
  short_domain: string | null;
};
type OfferInfo = {
  id: number;
  name: string;
  color: string | null;
  sales_pages?: SalesPage[];
  // Needed for the Full URL builder: postfix is the tracking-param NAME,
  // base_url is the fallback stem when no sales page is selected.
  base_url?: string | null;
  postfix?: string | null;
};

type AudiencePreview = {
  count: number;
  breakdown: {
    no_status: number;
    clickers: number;
    excluded_for_optout: number;
  };
  pool_size: number;
  // "projected" when the parent campaign is still a draft (pool not yet
  // frozen); "frozen" once the campaign has been activated. The UI uses
  // it to swap labels and to nudge the operator about draft state.
  mode: "projected" | "frozen";
  // Content-dedup eligibility breakdown (Phase 2 §5). truncated ⇒ the segment
  // was too large to compute within the timeout; show a soft note, don't fail.
  eligibility: {
    segment_total: number | null;
    saw_creative: number;
    got_offer: number;
    will_send: number | null;
    truncated: boolean;
    offer_excluded: boolean;
  };
};

export interface StageFormActionContext {
  isEdit: boolean;
  isSubmitting: boolean;
  onSave: () => Promise<void>;
  onCancel: () => void;
}

export interface StageFormProps {
  mode: "create" | "edit";
  campaignId: number;
  // Only set in edit mode; needed for the per-stage export URL.
  stageId?: number;
  // Edit-mode only: the existing stage's tracking_id (null when the
  // parent campaign or this stage's creative haven't reached the state
  // where one can be generated). Always null in create mode — the ID is
  // generated on save and surfaced only after the next fetch.
  trackingId?: string | null;
  // The parent campaign's tracking_id (when it has one — i.e. brand+offer
  // are set). Used together with nextStageNumber to compute a LIVE stage
  // tracking-ID preview in create mode so the operator can copy it before
  // saving.
  campaignTrackingId?: string | null;
  // Create-mode only: the stage_number this new stage will be assigned
  // (max existing + 1). Powers the tracking-ID preview.
  nextStageNumber?: number;
  // Edit-mode only: existing split assignment (NULL when the stage isn't
  // part of a split). Controls whether the "Split for A/B" action is
  // shown and renders a "Split X of Y" badge in the audience block.
  splitIndex?: number | null;
  splitTotal?: number | null;
  // Edit-mode only: this stage's behavioral_tier (NULL ⇒ ordinary stage). When
  // set, the stage is itself a behavioral lane and CANNOT be behaviorally split
  // again, so the "Behavioral split" action is hidden.
  behavioralTier?: number | null;
  // Edit-mode only: the stage's sent_at. When set on a tracked (API) campaign,
  // the send has fired and the Scheduled field locks (see CLAUDE.md §10g / the
  // send-scheduled flow). NULL = not yet sent (editable / reschedulable, even
  // if a prior scheduled attempt was missed).
  sentAt?: string | null;
  // Edit-mode only: the stage is ARMED — pre-materialized for a future schedule
  // (Approve-Send flow) but not yet released. The Scheduled field locks just like
  // a fired send; the operator must "Cancel armed send" to reschedule. NULL/false
  // when not armed.
  armed?: boolean;
  // Edit-mode only: invoked after the split endpoint succeeds. Parent
  // should refetch its stages list and close the editor (the source
  // stage's label/audience change in place plus N-1 new siblings appear).
  onSplit?: (result: {
    source_id: number;
    new_stage_ids: number[];
    split_total: number;
  }) => void;
  // Edit-mode only: invoked when the operator triggers a behavioral split from
  // the editor. The parent closes the editor and runs its own confirm + POST
  // (the same flow as the stages-row "Behavioral split…" action), so the two
  // entry points share one implementation.
  onBehavioralSplit?: () => void;
  campaign: {
    id: number;
    name: string;
    link_mode: "manual" | "tracked";
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
    scrubbed_count: number;
    bounced_count: number;
    checkout_click_count: number;
    sales_count: number;
    total_cost: string;
  };
  onImportResults?: () => void;
  onManualResults?: () => void;
  onViewImportHistory?: () => void;
  initialValues?: Partial<StageFormValues>;
  onSubmit: (values: StageFormValues) => Promise<void>;
  onCancel: () => void;
  isSubmitting: boolean;
  // Optional renderer for the action row. When set, the form skips its
  // default Cancel/Save row and renders this instead. The drawer host
  // uses this to put Cancel/Save in a sticky footer outside the form's
  // scroll container.
  renderActions?: (ctx: StageFormActionContext) => React.ReactNode;
}

const NONE = "__none__";

// Shared helper — maps form values to the API request body. Used by the
// inline creator and edit drawer.
export function buildStageCreateBody(
  values: StageFormValues,
): Record<string, unknown> {
  return {
    label: values.label.trim() ? values.label.trim() : undefined,
    creative_id: values.creative_id,
    sms_provider_id: values.sms_provider_id,
    provider_phone_id: values.provider_phone_id,
    sales_page_label: values.sales_page_label || undefined,
    short_url: values.short_url.trim() || undefined,
    full_url: values.full_url.trim() || undefined,
    utm_tag_ids: values.utm_tag_ids,
    full_url_auto: values.full_url_auto,
    stop_text: values.stop_text,
    include_no_status: values.include_no_status,
    include_clickers: values.include_clickers,
    exclude_clickers: values.exclude_clickers,
    scheduled_at: values.scheduled_at
      ? campaignLocalInputToUtcIso(values.scheduled_at)
      : null,
    notes: values.notes.trim() ? values.notes.trim() : undefined,
  };
}

const DEFAULT_VALUES: StageFormValues = {
  label: "",
  creative_id: null,
  sms_provider_id: null,
  provider_phone_id: null,
  sales_page_label: "",
  short_url: "",
  full_url: "",
  utm_tag_ids: [],
  full_url_auto: true,
  stop_text: "Stop to END",
  include_no_status: true,
  // Default to including clickers so a fresh stage shows the maximum
  // audience drawn from the campaign's frozen pool. Operators who want
  // to exclude past clickers can flip exclude_clickers — or unselect
  // include_clickers — explicitly.
  include_clickers: true,
  exclude_clickers: false,
  scheduled_at: "",
  notes: "",
};

// =============== Component ===============

export function StageForm({
  mode,
  campaignId,
  stageId,
  trackingId,
  campaignTrackingId,
  nextStageNumber,
  splitIndex,
  splitTotal,
  behavioralTier,
  sentAt,
  armed,
  onSplit,
  onBehavioralSplit,
  campaign,
  resultsCounters,
  onImportResults,
  onManualResults,
  onViewImportHistory,
  initialValues,
  onSubmit,
  onCancel,
  isSubmitting,
  renderActions,
}: StageFormProps) {
  const isEdit = mode === "edit";

  // Reference data
  const creativesApi = useApiCall<{ data: Creative[] }>();
  // Single-creative fetch — fallback for the edit-load case where the saved
  // creative belongs to an offer outside this campaign's (picked via the
  // picker's offer widening), so the offer-scoped list above doesn't include it.
  const creativeByIdApi = useApiCall<{
    id: number;
    slug: string;
    text: string;
    status: string;
    spam_score: number | null;
  }>();
  const providersApi = useApiCall<{ data: Provider[] }>();
  const phonesApi = useApiCall<{ data: ProviderPhone[] }>();
  const previewApi = useApiCall<AudiencePreview>();
  const createCreativeApi = useApiCall<{ id: number }>();
  // Create-then-split path: when the user clicks "Split for A/B test…"
  // on a brand-new (unsaved) stage, we save it first via this call so
  // the split endpoint has a stage_id to operate on, then immediately
  // POST /split. Bypasses the parent's onSubmit (which would close the
  // editor) and lets onSplit handle the refetch+close in one beat.
  const createForSplitApi = useApiCall<{ id: number }>();
  const splitApi = useApiCall<{
    source_id: number;
    new_stage_ids: number[];
    split_total: number;
  }>();
  const utmApi = useApiCall<{ data: UtmTag[] }>();
  const [creatives, setCreatives] = useState<Creative[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [phones, setPhones] = useState<ProviderPhone[]>([]);
  const [utmTags, setUtmTags] = useState<UtmTag[]>([]);
  // UTM tags are gated on the feature flag; treat the list as "loaded" up
  // front when the entity is unavailable so the full_url reconcile below
  // doesn't wait forever.
  const utmAvailable = isEntityAvailable("utm_tags");
  const [utmLoaded, setUtmLoaded] = useState(!utmAvailable);
  const [newCreativeOpen, setNewCreativeOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  // 2–5 in the UI per product spec; the endpoint caps at 10 if someone
  // POSTs directly.
  const [splitCount, setSplitCount] = useState<number>(2);

  // Creatives are filtered by the campaign's offer + status=active so we
  // don't accidentally send unfinished copy. If the campaign has no offer
  // yet (rare — drafts), skip the fetch.
  // Picker eligibility: active creatives that either apply to all offers
  // OR are linked to this campaign's offer via the creative_offers junction.
  // The list endpoint's offer_id filter handles the OR-with-all logic.
  const refetchCreatives = useMemo(
    () => async () => {
      if (!campaign.offer?.id) return [] as Creative[];
      const r = await creativesApi.execute(
        `/api/creatives/list?pageSize=200&offer_id=${campaign.offer.id}&status=active`,
      );
      if (r.ok) {
        setCreatives(r.data.data);
        return r.data.data;
      }
      return [] as Creative[];
    },
    [campaign.offer?.id, creativesApi.execute],
  );
  useEffect(() => {
    void refetchCreatives();
  }, [refetchCreatives]);

  useEffect(() => {
    (async () => {
      const r = await providersApi.execute(
        "/api/providers/list?pageSize=200&status=active",
      );
      if (r.ok) setProviders(r.data.data);
    })();
  }, [providersApi.execute]);

  // UTM tags for the Full URL link-builder. Gated on the feature flag so we
  // don't make a speculative request when the entity isn't built.
  useEffect(() => {
    if (!utmAvailable) return;
    (async () => {
      const r = await utmApi.execute(
        "/api/utm-tags/list?pageSize=200&status=active",
      );
      if (r.ok) setUtmTags(r.data.data);
      setUtmLoaded(true);
    })();
  }, [utmApi.execute, utmAvailable]);

  // Form setup
  const form = useForm<StageFormValues>({
    defaultValues: { ...DEFAULT_VALUES, ...initialValues },
  });

  const watchedCreativeId = form.watch("creative_id");
  const watchedProviderId = form.watch("sms_provider_id");
  const watchedPhoneId = form.watch("provider_phone_id");
  const watchedStopText = form.watch("stop_text");
  const watchedShortUrl = form.watch("short_url");
  const watchedIncludeNoStatus = form.watch("include_no_status");
  const watchedIncludeClickers = form.watch("include_clickers");
  const watchedExcludeClickers = form.watch("exclude_clickers");
  const watchedSalesPageLabel = form.watch("sales_page_label");
  const watchedFullUrl = form.watch("full_url");
  const watchedFullUrlAuto = form.watch("full_url_auto");
  const watchedScheduledAt = form.watch("scheduled_at");

  // Backfill the selected creative if the offer-scoped list doesn't include it
  // (a cross-offer pick made via the picker's offer widening). Waits for the
  // list fetch to settle so it doesn't fire for creatives that load normally.
  // setState lands inside the async callback (not synchronously in the effect).
  useEffect(() => {
    const id = watchedCreativeId;
    if (id === null || creativesApi.isLoading) return;
    if (creatives.some((c) => c.id === id)) return;
    let cancelled = false;
    (async () => {
      const r = await creativeByIdApi.execute(`/api/creatives/${id}`);
      if (cancelled || !r.ok) return;
      const c = r.data;
      const verdict =
        c.spam_score === null ? null : c.spam_score > 50 ? "spam" : "not_spam";
      setCreatives((prev) =>
        prev.some((x) => x.id === c.id)
          ? prev
          : [
              {
                id: c.id,
                slug: c.slug,
                text: c.text,
                status: c.status,
                spam_score: c.spam_score,
                spam_verdict: verdict,
              },
              ...prev,
            ],
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [
    watchedCreativeId,
    creatives,
    creativesApi.isLoading,
    creativeByIdApi.execute,
  ]);

  // Provider phones reload when the selected provider changes. If the
  // currently selected phone doesn't belong to the new provider, clear it.
  // In create mode, also auto-select when the active provider exposes
  // exactly one phone — saves a click in the common single-phone case.
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
        if (
          !isEdit &&
          r.data.data.length === 1 &&
          form.getValues("provider_phone_id") === null
        ) {
          form.setValue("provider_phone_id", r.data.data[0].id, {
            shouldDirty: false,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedProviderId, phonesApi.execute]);

  // Auto-select dropdowns that have exactly one option when creating a
  // new stage. Edit mode is intentionally skipped so we don't override
  // an explicit historical choice. shouldDirty: false to keep the form's
  // dirty state honest (auto-fills don't trigger the discard prompt).
  useEffect(() => {
    if (isEdit) return;
    if (creatives.length === 1 && form.getValues("creative_id") === null) {
      form.setValue("creative_id", creatives[0].id, { shouldDirty: false });
    }
  }, [isEdit, creatives, form]);
  useEffect(() => {
    if (isEdit) return;
    if (providers.length === 1 && form.getValues("sms_provider_id") === null) {
      form.setValue("sms_provider_id", providers[0].id, {
        shouldDirty: false,
      });
    }
  }, [isEdit, providers, form]);
  // Sales-page list comes from the campaign's offer (campaign.offer.sales_pages),
  // not an API. Auto-select when the offer has exactly one entry. Stored
  // as a string label, not an id.
  useEffect(() => {
    if (isEdit) return;
    const pages = campaign.offer?.sales_pages ?? [];
    if (pages.length === 1 && form.getValues("sales_page_label") === "") {
      form.setValue("sales_page_label", pages[0].label, { shouldDirty: false });
    }
  }, [isEdit, campaign.offer?.sales_pages, form]);

  // ============ SMS preview ============
  const selectedCreative = useMemo(
    () => creatives.find((c) => c.id === watchedCreativeId) ?? null,
    [creatives, watchedCreativeId],
  );
  const brandName = campaign.brand?.name ?? "";
  // Shared composer (lib/sends/stage-sms.ts) — the SAME builder the send
  // pipeline uses, so the preview and the sent body can never diverge. When a
  // link is present it lands on its own line between the creative text and the
  // stop text; full_url is tracking metadata and never enters the SMS.
  const trimmedShortUrl = (watchedShortUrl ?? "").trim();

  // Tracked mode: the real link is minted per-recipient at kickoff, so we
  // preview a REPRESENTATIVE link of the exact shape + length —
  // https://<brand active short domain>/r/<7-char code> (CODE_LENGTH=7) — so
  // the character/segment count is exact. No minting happens here.
  const isTracked = campaign.link_mode === "tracked";

  // Scheduled-send gating (tracked/API campaigns only):
  // • Locked once the send has fired (sentAt set) — the time can no longer change.
  //   A missed scheduled attempt leaves sentAt NULL, so it stays editable.
  // • Quiet-hours warning (non-blocking) when the chosen time falls outside the
  //   selected provider's auto-send window — the message just won't auto-send then.
  const scheduledLocked = isTracked && (!!sentAt || !!armed);
  const selectedProvider = providers.find((p) => p.id === watchedProviderId);
  const scheduledOutsideWindow = (() => {
    if (!isTracked || !watchedScheduledAt || !selectedProvider) return false;
    try {
      const utc = new Date(campaignLocalInputToUtcIso(watchedScheduledAt));
      if (Number.isNaN(utc.getTime())) return false;
      return isOutsideSendWindow(selectedProvider, utc);
    } catch {
      return false;
    }
  })();
  // A stage can't be scheduled in the past. Only flag (and block save) when the
  // value CHANGED from what loaded — an unrelated edit to a stage with a
  // historical schedule must still save (the server enforces the same rule).
  const scheduledInPast = (() => {
    if (scheduledLocked || !watchedScheduledAt) return false;
    if (watchedScheduledAt === (initialValues?.scheduled_at ?? "")) return false;
    try {
      return isScheduledAtInPast(campaignLocalInputToUtcIso(watchedScheduledAt));
    } catch {
      return false;
    }
  })();

  const brandShortDomain = campaign.brand?.short_domain ?? null;
  const TRACKED_CODE_PLACEHOLDER = "XXXXXXX"; // 7 chars = mint CODE_LENGTH
  const trackedLinkPreview = brandShortDomain
    ? `https://${brandShortDomain}/r/${TRACKED_CODE_PLACEHOLDER}`
    : null;
  // Which link line the preview composes with:
  //  - tracked + brand has a short domain → the representative tracked link
  //  - tracked + no short domain → none (a warning is shown instead of a fake link)
  //  - manual → the pasted Short URL
  const previewLinkUrl = isTracked ? (trackedLinkPreview ?? "") : trimmedShortUrl;
  const assembledSms = buildStageSms({
    brandName,
    creativeText: selectedCreative?.text,
    linkUrl: previewLinkUrl,
    stopText: watchedStopText,
  });
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

  async function handleCopySmsPreview() {
    if (!assembledSms) return;
    try {
      await navigator.clipboard.writeText(assembledSms);
      toast.success("SMS preview copied");
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  }

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
            split_index: splitIndex ?? null,
            split_total: splitTotal ?? null,
            // Drives the content-dedup eligibility breakdown (saw-this-creative
            // / will-send). Null ⇒ no creative dedup (Edge A).
            creative_id: watchedCreativeId ?? null,
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
    splitIndex,
    splitTotal,
    watchedCreativeId,
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

  // ============ Tracking ID preview + Full URL builder ============
  // Live stage tracking-ID: the real value in edit mode; a computed preview
  // in create mode (campaign tracking ID + predicted stage number + creative)
  // so the operator can copy it before saving.
  const effectiveTrackingId = useMemo(() => {
    if (isEdit) return trackingId ?? null;
    if (
      campaignTrackingId &&
      watchedCreativeId != null &&
      nextStageNumber != null
    ) {
      return formatStageTrackingId({
        campaignTrackingId,
        stageNumber: nextStageNumber,
        creativeId: watchedCreativeId,
      });
    }
    return null;
  }, [
    isEdit,
    trackingId,
    campaignTrackingId,
    watchedCreativeId,
    nextStageNumber,
  ]);

  const generatedFullUrl = useMemo(() => {
    // Auto value is the BARE sales-page URL. The tracking ID and UTM params
    // are attached manually via the chips below the field.
    const sp = (campaign.offer?.sales_pages ?? []).find(
      (p) => p.label === watchedSalesPageLabel,
    );
    return (sp?.url ?? "").trim();
  }, [campaign.offer?.sales_pages, watchedSalesPageLabel]);

  // A UTM chip brings only the parameter NAME (the tag's Value Source) with a
  // trailing "=", e.g. clicking "subid5" appends "?sub_id5=". Toggling off
  // removes that whole param segment. Any chip click flips the field to
  // hand-edited so the server stores it verbatim (not the bare sales-page URL).
  function toggleUtmTag(tag: UtmTag) {
    const current = form.getValues("full_url");
    const present = hasUrlParam(current, tag.value_source);
    const next = present
      ? removeUrlParam(current, tag.value_source)
      : appendParamName(current, tag.value_source);
    form.setValue("full_url", next, { shouldDirty: true });
    form.setValue("full_url_auto", false, { shouldDirty: true });
    // Keep utm_tag_ids in sync (persisted record).
    const ids = form.getValues("utm_tag_ids") ?? [];
    const nextIds = present
      ? ids.filter((x) => x !== tag.id)
      : ids.includes(tag.id)
        ? ids
        : [...ids, tag.id];
    form.setValue("utm_tag_ids", nextIds, { shouldDirty: true });
  }

  // The tracking_id chip brings only the VALUE — it appends the stage tracking
  // ID to the end of the URL (right after the "=" of the param added before
  // it). Toggling off removes that value substring.
  function toggleTrackingId() {
    if (!effectiveTrackingId) return;
    const current = form.getValues("full_url");
    const next = current.includes(effectiveTrackingId)
      ? removeRawValue(current, effectiveTrackingId)
      : appendRawValue(current, effectiveTrackingId);
    form.setValue("full_url", next, { shouldDirty: true });
    form.setValue("full_url_auto", false, { shouldDirty: true });
  }

  // full_url auto-derives from the selections (and re-derives as they change)
  // but stays hand-editable. On edit we reconcile once UTM tags load: if the
  // stored URL looks hand-customized, switch auto off so we don't clobber it;
  // otherwise keep it synced to the generated value.
  const initialFullUrlRef = useRef(initialValues?.full_url ?? "");
  const reconciledRef = useRef(!isEdit);

  useEffect(() => {
    if (!reconciledRef.current) {
      reconciledRef.current = true;
      const stored = initialFullUrlRef.current.trim();
      // A stored URL that isn't just the bare sales-page URL has manual
      // params (tracking/UTM) — treat it as hand-edited so we don't wipe them.
      if (stored && stored !== generatedFullUrl) {
        form.setValue("full_url_auto", false, { shouldDirty: false });
        return;
      }
    }
    if (form.getValues("full_url_auto")) {
      if (form.getValues("full_url") !== generatedFullUrl) {
        form.setValue("full_url", generatedFullUrl, { shouldDirty: false });
      }
    }
  }, [generatedFullUrl, form]);

  function resetFullUrlToGenerated() {
    reconciledRef.current = true;
    form.setValue("full_url_auto", true, { shouldDirty: true });
    form.setValue("full_url", generatedFullUrl, { shouldDirty: true });
  }

  // Submit
  async function handleSave() {
    if (scheduledInPast) {
      toast.error("Scheduled time can't be in the past");
      return;
    }
    await onSubmit(form.getValues());
  }

  // Inline "+ New creative" flow. POSTs a single creative bound to the
  // campaign's offer, refetches the picker list, and auto-selects the
  // freshly created creative on success. Skipped silently when the
  // campaign has no offer (the menu item is also hidden in that case).
  // Picker selection: the chosen creative may belong to an offer the parent's
  // offer-scoped fetch didn't load (the picker can widen by offer), so merge it
  // into local state to keep the SMS preview working before setting the field.
  function handleCreativeSelected(c: PickerCreative) {
    setCreatives((prev) =>
      prev.some((x) => x.id === c.id)
        ? prev
        : [
            {
              id: c.id,
              slug: c.slug,
              text: c.text,
              status: c.status,
              spam_score: c.spam_score,
              spam_verdict: c.spam_verdict,
            },
            ...prev,
          ],
    );
    form.setValue("creative_id", c.id, { shouldDirty: true });
    setPickerOpen(false);
  }

  async function handleCreateInlineCreative(values: CreativeFormValues) {
    if (!campaign.offer?.id) return;
    const result = await createCreativeApi.execute("/api/creatives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: values.text,
        creative_id:
          values.creative_id && values.creative_id !== ""
            ? values.creative_id
            : undefined,
        quality: values.quality,
        sequence_placement: values.sequence_placement,
        applies_to_all_offers: values.applies_to_all_offers,
        offer_ids: values.offer_ids,
      }),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't create creative");
      return;
    }
    const newId = result.data.id;
    setNewCreativeOpen(false);
    toast.success("Creative created");
    // Refresh the picker list so the new row is present, then select it.
    const next = await refetchCreatives();
    if (next.some((c) => c.id === newId)) {
      form.setValue("creative_id", newId, { shouldDirty: true });
    }
  }

  async function handleSplitSubmit() {
    // Two paths:
    //   edit mode → split the existing stageId directly.
    //   create mode → save the stage first (using the form's current
    //     values) and split the freshly-minted row. The user sees one
    //     click; under the hood it's POST /stages then POST /split.
    let sourceStageId: number | null = isEdit ? stageId ?? null : null;
    if (sourceStageId === null) {
      const createRes = await createForSplitApi.execute(
        `/api/campaigns/${campaignId}/stages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildStageCreateBody(form.getValues())),
        },
      );
      if (!createRes.ok) {
        toastApiError(createRes, "Couldn't save stage before splitting");
        return;
      }
      sourceStageId = createRes.data.id;
    }
    const result = await splitApi.execute(
      `/api/campaigns/${campaignId}/stages/${sourceStageId}/split`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: splitCount }),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't split stage");
      return;
    }
    setSplitOpen(false);
    toast.success(
      `Stage split into ${result.data.split_total} siblings for A/B`,
    );
    onSplit?.(result.data);
  }

  const isAlreadySplit = splitTotal != null && splitTotal >= 2;
  const canSplit =
    !isAlreadySplit &&
    audiencePreview !== null &&
    audiencePreview.count >= 2;

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
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (!isSubmitting) void handleSave();
            return;
          }
          if (
            e.key === "Escape" &&
            !e.defaultPrevented &&
            !isSubmitting
          ) {
            if (
              form.formState.isDirty &&
              !window.confirm("Discard unsaved changes?")
            ) {
              return;
            }
            e.preventDefault();
            onCancel();
          }
        }}
        className="grid gap-6"
        noValidate
      >
        {/* ============ Two-column body ============ */}
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <div className="grid min-w-0 gap-4">
            {/* Essentials — inline label + input */}
            <div className="grid items-start gap-4 sm:grid-cols-2">
              {/* Label + Tracking ID, stacked in the left column */}
              <div className="space-y-3">
                <FormField
                  control={form.control}
                  name="label"
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-3 space-y-0">
                      <FormLabel className="shrink-0">Label</FormLabel>
                      <div className="flex-1">
                        <FormControl>
                          <Input
                            placeholder="e.g. Day 1 Initial Push"
                            disabled={isSubmitting}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </div>
                    </FormItem>
                  )}
                />
                <CopyableId
                  label="Tracking ID"
                  value={effectiveTrackingId}
                  inputClassName="text-xs md:text-xs"
                  placeholder={
                    isEdit
                      ? "Pick a creative & save to generate"
                      : campaignTrackingId
                        ? "Pick a creative to generate"
                        : "Set brand & offer on the campaign"
                  }
                  helperText={
                    isEdit
                      ? effectiveTrackingId
                        ? "Auto-generated. Used in analytics URLs."
                        : "Auto-generated when the campaign and creative are set."
                      : effectiveTrackingId
                        ? "Preview — finalized on save. Copy it now for tracking."
                        : "Auto-generated on save once a creative is picked."
                  }
                  copiedMessage="Tracking ID copied"
                />
              </div>

              {/* Scheduled + quick-schedule presets, stacked in the right column */}
              <div className="space-y-2">
                <FormField
                  control={form.control}
                  name="scheduled_at"
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-3 space-y-0">
                      <FormLabel className="shrink-0">Scheduled</FormLabel>
                      <div className="flex-1">
                        <FormControl>
                          <Input
                            type="datetime-local"
                            disabled={isSubmitting || scheduledLocked}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </div>
                    </FormItem>
                  )}
                />
                {!scheduledLocked ? (
                  <ScheduledPresets
                    disabled={isSubmitting}
                    onPick={(v) =>
                      form.setValue("scheduled_at", v, { shouldDirty: true })
                    }
                  />
                ) : null}
                {scheduledLocked ? (
                  <p className="text-xs text-muted-foreground">
                    {armed
                      ? "Locked — this stage is armed (messages materialized for this schedule). Cancel the armed send to reschedule."
                      : "Locked — this stage has been sent. The scheduled time can't be changed."}
                  </p>
                ) : scheduledInPast ? (
                  <p className="text-xs text-red-700 dark:text-red-400">
                    This time is in the past. Pick a future time to schedule the
                    send.
                  </p>
                ) : scheduledOutsideWindow ? (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    This time is outside {selectedProvider?.name ?? "the provider"}&apos;s
                    sending hours — the message won&apos;t auto-send then. It holds
                    until the window opens, or is marked missed if the day&apos;s
                    window has closed.
                  </p>
                ) : null}
              </div>
            </div>

        {/* ============ Sales page & URLs ============ */}
        <div className="grid gap-3 border-t pt-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Sales page & URLs
          </span>
          {/* Row 1: Creative + Sales page packed in left col, Stop text in right col */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="creative_id"
                render={() => (
                  <FormItem>
                    <FormLabel>Creative</FormLabel>
                    {/* Opens the rich picker dialog (search, filters, EPC/CTR,
                        live SMS preview). One creative per stage. */}
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9 w-full justify-start gap-2 overflow-hidden font-normal"
                      disabled={isSubmitting}
                      onClick={() => setPickerOpen(true)}
                    >
                      {selectedCreative ? (
                        <span className="inline-flex min-w-0 items-center gap-2">
                          <SpamScoreDot
                            score={selectedCreative.spam_score}
                            verdict={selectedCreative.spam_verdict}
                          />
                          <span className="font-mono text-xs">
                            {selectedCreative.slug}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {selectedCreative.text}
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          Pick a creative
                        </span>
                      )}
                    </Button>
                    {/* Full creative text under the picker so the operator
                        can read what they selected in one place. Hidden
                        until a creative is actually picked. */}
                    {selectedCreative ? (
                      <div className="mt-1 rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs">
                        <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                          Creative text
                        </div>
                        <p className="whitespace-pre-wrap font-mono text-sm leading-snug text-foreground">
                          {selectedCreative.text}
                        </p>
                      </div>
                    ) : null}
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
            </div>

            <FormField
              control={form.control}
              name="stop_text"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Stop text</FormLabel>
                  <FormControl>
                    <Input disabled={isSubmitting} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          {/* Row 2: Short URL + Full URL aligned with the 2-col grid above */}
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="short_url"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Short URL</FormLabel>
                  <div className="flex items-stretch gap-1.5">
                    <FormControl>
                      <Input
                        placeholder="e.g. lnk.example.com/abc123"
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FieldCopyButton
                      value={field.value ?? ""}
                      label="Short URL"
                      disabled={isSubmitting}
                    />
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="full_url"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center justify-between">
                    <FormLabel>Full URL</FormLabel>
                    {!watchedFullUrlAuto ? (
                      <button
                        type="button"
                        onClick={resetFullUrlToGenerated}
                        disabled={isSubmitting}
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-60"
                      >
                        <RotateCcw className="size-3" aria-hidden />
                        Reset to generated
                      </button>
                    ) : null}
                  </div>
                  <div className="flex items-stretch gap-1.5">
                    <FormControl>
                      <Input
                        placeholder="Auto-fills from the sales page, tracking ID & UTM tags"
                        disabled={isSubmitting}
                        {...field}
                        onChange={(e) => {
                          // Hand-edit ⇒ stop auto-deriving and store verbatim.
                          field.onChange(e);
                          if (form.getValues("full_url_auto")) {
                            form.setValue("full_url_auto", false, {
                              shouldDirty: true,
                            });
                          }
                        }}
                      />
                    </FormControl>
                    <FieldCopyButton
                      value={field.value ?? ""}
                      label="Full URL"
                      disabled={isSubmitting}
                    />
                  </div>
                  <FormDescription className="text-xs">
                    {watchedFullUrlAuto
                      ? "Auto-built from the sales page + the offer's tracking param + tracking ID + the UTM tags below."
                      : "Custom — edited by hand. Use “Reset to generated” to rebuild from the selections."}
                  </FormDescription>
                  {/* Param chips — click to build the URL. A UTM chip appends
                      its Value Source as a param name (e.g. "sub_id5="); the
                      tracking_id chip appends the tracking ID value after it.
                      Toggle a chip to remove its contribution. */}
                  <UrlParamChips
                    trackingId={effectiveTrackingId}
                    utmAvailable={utmAvailable}
                    utmTags={utmTags}
                    utmLoading={utmApi.isLoading && !utmLoaded}
                    fullUrl={watchedFullUrl ?? ""}
                    disabled={isSubmitting}
                    onToggleTracking={toggleTrackingId}
                    onToggleUtm={toggleUtmTag}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* ============ Provider, phone & audience filters ============ */}
        <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
          {/* Left: Provider & Phone */}
          <div className="grid gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Provider & Phone
            </span>
            <div className="grid gap-3 sm:grid-cols-2">
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
          </div>

          {/* Right: Audience filters */}
          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Audience filters
              </span>
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
            <div className="flex flex-wrap items-center gap-2">
              <FilterChip
                label="Include no-status"
                tooltip="No recorded activity at snapshot time"
                active={watchedIncludeNoStatus}
                onClick={() =>
                  form.setValue(
                    "include_no_status",
                    !watchedIncludeNoStatus,
                    { shouldDirty: true },
                  )
                }
                disabled={isSubmitting}
              />
              <FilterChip
                label="Include clickers"
                tooltip="Contacts who were clickers at snapshot time"
                active={watchedIncludeClickers}
                onClick={() => setIncludeClickers(!watchedIncludeClickers)}
                disabled={isSubmitting}
              />
              <FilterChip
                label="Exclude clickers"
                tooltip="Drop anyone who clicked previously"
                active={watchedExcludeClickers}
                onClick={() => setExcludeClickers(!watchedExcludeClickers)}
                disabled={isSubmitting}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              · Opt-outs always excluded
            </p>
          </div>
        </div>
          </div>

          {/* ============ Right aside: previews + results ============ */}
          <aside className="grid min-w-0 gap-3 lg:sticky lg:top-4 lg:self-start">
            {/* SMS preview */}
            <Card>
              <CardContent className="grid gap-2 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <div className="text-xs uppercase text-muted-foreground">
                    SMS preview
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={handleCopySmsPreview}
                    disabled={!selectedCreative}
                    aria-label={
                      selectedCreative
                        ? "Copy SMS preview"
                        : "Select a creative to copy the SMS preview"
                    }
                    title={selectedCreative ? "Copy SMS preview" : undefined}
                  >
                    <Copy className="size-4" aria-hidden />
                  </Button>
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
                {isTracked ? (
                  trackedLinkPreview ? (
                    <p className="text-xs text-muted-foreground">
                      Tracked link:{" "}
                      <span className="font-mono">{trackedLinkPreview}</span> — the
                      real code is unique per recipient (7 chars), so the count
                      above is exact.
                    </p>
                  ) : (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      No short domain set for {brandName || "this brand"} — set one
                      in Brands before sending. The preview omits the link until
                      then.
                    </p>
                  )
                ) : null}
              </CardContent>
            </Card>

            {/* Stage audience preview */}
            <Card>
              <CardContent className="grid gap-2 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <div className="text-xs uppercase text-muted-foreground">
                    Stage audience
                  </div>
                  <div className="flex items-center gap-2">
                    {isAlreadySplit ? (
                      <Badge variant="secondary" className="text-[10px]">
                        Split {splitIndex} of {splitTotal}
                      </Badge>
                    ) : null}
                    {audienceLoading ? (
                      <Loader2
                        className="size-4 animate-spin text-muted-foreground"
                        aria-hidden
                      />
                    ) : null}
                  </div>
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
                        of {audiencePreview.pool_size.toLocaleString()}{" "}
                        {audiencePreview.mode === "projected"
                          ? "projected"
                          : "frozen"}
                      </span>
                    </div>
                    {audiencePreview.mode === "projected" ? (
                      <p className="text-[11px] text-amber-700 dark:text-amber-400">
                        Parent campaign is still a draft — the pool freezes at
                        activation. Numbers may shift slightly when the random
                        sample is taken.
                      </p>
                    ) : null}
                    <div className="grid gap-0.5 text-xs text-muted-foreground">
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
                        Opted out:{" "}
                        <span className="font-mono tabular-nums text-foreground">
                          {audiencePreview.breakdown.excluded_for_optout.toLocaleString()}
                        </span>
                      </span>
                    </div>
                    {/* Content-dedup eligibility breakdown (Phase 2 §5). */}
                    {audiencePreview.eligibility.truncated ? (
                      <p className="text-[11px] text-muted-foreground">
                        Audience too large to compute the dedup preview — it
                        still applies at send time.
                      </p>
                    ) : (
                      <div className="grid gap-0.5 rounded-md border border-dashed p-2 text-xs text-muted-foreground">
                        <span>
                          Already saw this creative:{" "}
                          <span className="font-mono tabular-nums text-foreground">
                            {audiencePreview.eligibility.saw_creative.toLocaleString()}
                          </span>
                        </span>
                        {audiencePreview.eligibility.offer_excluded ? (
                          <span>
                            Already got this offer:{" "}
                            <span className="font-mono tabular-nums text-foreground">
                              {audiencePreview.eligibility.got_offer.toLocaleString()}
                            </span>
                          </span>
                        ) : null}
                        <span className="font-medium text-foreground">
                          Will send:{" "}
                          <span className="font-mono tabular-nums">
                            {(
                              audiencePreview.eligibility.will_send ??
                              audiencePreview.count
                            ).toLocaleString()}
                          </span>
                        </span>
                      </div>
                    )}
                    {audienceEmpty ? (
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        Empty audience. Adjust filters or check the parent
                        campaign.
                      </p>
                    ) : null}
                    {canSplit ? (
                      <div className="border-t pt-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setSplitCount(2);
                            setSplitOpen(true);
                          }}
                          disabled={
                            isSubmitting ||
                            splitApi.isLoading ||
                            createForSplitApi.isLoading
                          }
                          className="w-full"
                        >
                          Split for A/B test…
                        </Button>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {isEdit
                            ? "Partition this stage's audience into 2–5 siblings. Each sibling can hold its own creative."
                            : "Saves this stage first, then partitions its audience into 2–5 siblings. Each sibling can hold its own creative."}
                        </p>
                      </div>
                    ) : isAlreadySplit ? (
                      <p className="border-t pt-2 text-[11px] text-muted-foreground">
                        This stage is split {splitIndex} of {splitTotal}. To
                        re-split, delete the sibling splits first.
                      </p>
                    ) : null}
                    {/* Behavioral split — companion to the A/B split above. Only
                        on a saved ORDINARY stage (a lane can't be split again).
                        Hands off to the parent, which runs the same confirm +
                        POST as the stages-row "Behavioral split…" action. */}
                    {isEdit && onBehavioralSplit && behavioralTier == null ? (
                      <div className="border-t pt-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => onBehavioralSplit()}
                          disabled={isSubmitting}
                          className="w-full"
                        >
                          Behavioral split…
                        </Button>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Branch this position into 3 tier lanes — Ignored /
                          Clicked / Reached offer. Each recipient is routed by
                          their current behavior at send time.
                        </p>
                      </div>
                    ) : null}
                    {isEdit && behavioralTier != null ? (
                      <p className="border-t pt-2 text-[11px] text-muted-foreground">
                        This stage is a behavioral lane and can&apos;t be split
                        again.
                      </p>
                    ) : null}
                  </>
                )}
              </CardContent>
            </Card>

            {/* Notes */}
            <Card>
              <CardContent className="grid gap-2 p-3 text-sm">
                <div className="text-xs uppercase text-muted-foreground">
                  Notes
                </div>
                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Textarea
                          rows={2}
                          placeholder="Anything to remember for this stage"
                          disabled={isSubmitting}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            {/* Results (edit mode only) */}
            {isEdit && resultsCounters ? (
              <Card>
                <CardContent className="grid gap-2 p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs uppercase text-muted-foreground">
                      Results
                    </span>
                    <div className="flex items-center gap-1">
                      {onViewImportHistory ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={onViewImportHistory}
                        >
                          History
                        </Button>
                      ) : null}
                      {onManualResults ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={onManualResults}
                        >
                          Manual
                        </Button>
                      ) : null}
                      {onImportResults ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={onImportResults}
                        >
                          Import CSV
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
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
                      label="Scrubbed"
                      value={resultsCounters.scrubbed_count}
                    />
                    <ResultMetric
                      label="Bounced"
                      value={resultsCounters.bounced_count}
                    />
                    <ResultMetric
                      label="Checkout Clicks"
                      value={resultsCounters.checkout_click_count}
                    />
                    <ResultMetric
                      label="Sales"
                      value={resultsCounters.sales_count}
                    />
                    <ResultMetric
                      label="Total cost"
                      value={`$${Number(resultsCounters.total_cost).toFixed(2)}`}
                      raw
                    />
                  </div>
                </CardContent>
              </Card>
            ) : null}
          </aside>
        </div>

        {renderActions ? (
          renderActions({
            isEdit,
            isSubmitting,
            onSave: handleSave,
            onCancel,
          })
        ) : (
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
        )}
      </form>

      {/* Rich creative picker: search, sequence filter, offer widening,
          EPC/CTR columns, and a live SMS preview. Selecting sets creative_id.
          Mounted only while open so its internal filter/selection state resets
          fresh on each open. */}
      {pickerOpen ? (
        <CreativePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        campaignOffer={
          campaign.offer
            ? { id: campaign.offer.id, name: campaign.offer.name }
            : null
        }
        brandName={brandName}
        stopText={watchedStopText}
        linkPreviewUrl={previewLinkUrl}
        selectedCreativeId={watchedCreativeId}
        onSelect={handleCreativeSelected}
        onCreateNew={
          campaign.offer?.id
            ? () => {
                setPickerOpen(false);
                setNewCreativeOpen(true);
              }
            : undefined
        }
        />
      ) : null}

      {/* Inline new-creative dialog. Pre-fills the offer from the parent
          campaign so the new creative is immediately eligible for this
          stage's picker. Uses CreativeForm in create mode so the rendering
          stays consistent with /creatives. */}
      <FormDialog
        open={newCreativeOpen}
        onOpenChange={(open) => {
          if (!createCreativeApi.isLoading) setNewCreativeOpen(open);
        }}
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>New creative</DialogTitle>
          <DialogDescription>
            {campaign.offer?.name
              ? `Pre-linked to "${campaign.offer.name}". After saving, it will be selected for this stage.`
              : "Saved creative will be selected for this stage."}
          </DialogDescription>
        </DialogHeader>
        <CreativeForm
          mode="create"
          initialValues={{
            text: "",
            creative_id: "",
            quality: "unknown",
            sequence_placement: "unknown",
            applies_to_all_offers: false,
            offer_ids: campaign.offer?.id ? [campaign.offer.id] : [],
          }}
          onSubmit={handleCreateInlineCreative}
          onCancel={() => setNewCreativeOpen(false)}
          isSubmitting={createCreativeApi.isLoading}
        />
      </FormDialog>

      {/* Split-for-A/B dialog. Confirms count, fires the split endpoint,
          and lets the parent refetch. The source stage becomes split 1
          of N; (N-1) sibling stages are created with cloned config. */}
      <FormDialog
        open={splitOpen}
        onOpenChange={(open) => {
          if (!splitApi.isLoading && !createForSplitApi.isLoading) {
            setSplitOpen(open);
          }
        }}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Split stage for A/B test</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "This stage's audience will be partitioned into the chosen number of siblings. Each sibling clones the current configuration so you can swap the creative or other settings per variant. The split is deterministic — the same contact always lands in the same bucket."
              : "We'll save this stage first, then partition its audience into the chosen number of siblings. Each sibling clones the configuration you just filled in so you can swap the creative or other settings per variant. The split is deterministic — the same contact always lands in the same bucket."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Number of variants</label>
            <div className="flex flex-wrap gap-1.5">
              {[2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setSplitCount(n)}
                  disabled={splitApi.isLoading}
                  className={cn(
                    "rounded-full border px-3 py-1 text-sm transition-colors",
                    splitCount === n
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-background text-muted-foreground hover:bg-muted",
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {audiencePreview
                ? `~${Math.floor(
                    audiencePreview.count / splitCount,
                  ).toLocaleString()} contacts per variant (estimate based on current preview).`
                : "Estimate unavailable until the preview loads."}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setSplitOpen(false)}
            disabled={splitApi.isLoading || createForSplitApi.isLoading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSplitSubmit()}
            disabled={splitApi.isLoading || createForSplitApi.isLoading}
          >
            {splitApi.isLoading || createForSplitApi.isLoading ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : null}
            {createForSplitApi.isLoading
              ? "Saving…"
              : splitApi.isLoading
                ? "Splitting…"
                : `Split into ${splitCount}`}
          </Button>
        </div>
      </FormDialog>
    </Form>
  );
}

// =============== Sub-components ===============

// Renders a small color dot + score number for the creative picker.
// Green = not_spam, red = spam, gray = no cached score yet.
function SpamScoreDot({
  score,
  verdict,
}: {
  score: number | null;
  verdict: "spam" | "not_spam" | null;
}) {
  if (score === null) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-muted-foreground"
        title="Not scored yet"
      >
        <span className="size-2 rounded-full bg-muted-foreground/30" aria-hidden />
        <span className="font-mono">—</span>
      </span>
    );
  }
  const isSpam = verdict === "spam";
  return (
    <span
      className="inline-flex items-center gap-1 text-xs"
      title={`Spam score: ${score}/100 (${isSpam ? "SPAM" : "NOT SPAM"})`}
    >
      <span
        className={cn(
          "size-2 rounded-full",
          isSpam ? "bg-red-500" : "bg-green-500",
        )}
        aria-hidden
      />
      <span
        className={cn(
          "font-mono tabular-nums",
          isSpam ? "text-red-700 dark:text-red-300" : "text-green-700 dark:text-green-300",
        )}
      >
        {score}
      </span>
    </span>
  );
}

// Small copy-to-clipboard button placed inline next to an editable URL field.
// Mirrors the CopyableId affordance but for a (hand-editable) <Input>: disabled
// when empty, sonner toast on success.
function FieldCopyButton({
  value,
  label,
  disabled,
}: {
  value: string;
  label: string;
  disabled?: boolean;
}) {
  const isEmpty = value.trim().length === 0;

  async function handleCopy() {
    if (isEmpty) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={handleCopy}
      disabled={disabled || isEmpty}
      aria-label={isEmpty ? `${label} is empty` : `Copy ${label}`}
      title={isEmpty ? undefined : `Copy ${label}`}
    >
      <Copy className="size-4" aria-hidden />
    </Button>
  );
}

// Param chips shown directly below the Full URL. Clicking a chip appends its
// query param to the end of the URL (toggle to remove). The tracking_id chip
// inserts the offer postfix = stage tracking ID; each UTM chip inserts
// <tag_id>=<value_source>. Active state is derived from the URL text so it
// stays correct even when the field is hand-edited.
function UrlParamChips({
  trackingId,
  utmAvailable,
  utmTags,
  utmLoading,
  fullUrl,
  disabled,
  onToggleTracking,
  onToggleUtm,
}: {
  trackingId: string | null;
  utmAvailable: boolean;
  utmTags: UtmTag[];
  utmLoading: boolean;
  fullUrl: string;
  disabled?: boolean;
  onToggleTracking: () => void;
  onToggleUtm: (tag: UtmTag) => void;
}) {
  return (
    <div className="grid gap-1">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
        Attach to URL
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {utmAvailable ? (
          utmLoading ? (
            <span className="text-xs text-muted-foreground">
              Loading UTM tags…
            </span>
          ) : utmTags.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              No UTM tags yet.
            </span>
          ) : (
            utmTags.map((t) => (
              <ParamChip
                key={t.id}
                label={t.tag_id}
                color={t.color}
                active={hasUrlParam(fullUrl, t.value_source)}
                disabled={disabled}
                title={`${t.label} — appends ${t.value_source}=`}
                onClick={() => onToggleUtm(t)}
              />
            ))
          )
        ) : null}
        <ParamChip
          label="tracking_id"
          active={trackingId ? fullUrl.includes(trackingId) : false}
          disabled={disabled || !trackingId}
          accent
          title={
            trackingId
              ? `Appends the tracking ID value: ${trackingId}`
              : "Pick a creative (and set brand + offer) to generate the tracking ID"
          }
          onClick={onToggleTracking}
        />
      </div>
    </div>
  );
}

function ParamChip({
  label,
  active,
  disabled,
  title,
  onClick,
  color,
  accent,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  title: string;
  onClick: () => void;
  color?: string | null;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-xs transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : accent
            ? "border-primary/40 bg-primary/5 text-foreground hover:bg-primary/10"
            : "border-border bg-background text-muted-foreground hover:bg-muted",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      {color ? (
        <span
          className="size-2 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden
        />
      ) : null}
      {label}
    </button>
  );
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

function ScheduledPresets({
  disabled,
  onPick,
}: {
  disabled?: boolean;
  onPick: (yyyyMmDdTHHmm: string) => void;
}) {
  // ET wall-clock string for {today + daysOffset} at the given HH:mm.
  // datetime-local inputs are interpreted as ET wall-clock by the
  // server-side helper (campaignLocalInputToUtcIso).
  function etAt(daysOffset: number, hhmm: string): string {
    const d = new Date();
    d.setDate(d.getDate() + daysOffset);
    const ymd = formatInTimeZone(d, CAMPAIGN_TIMEZONE, "yyyy-MM-dd");
    return `${ymd}T${hhmm}`;
  }

  // Shared preset times, applied to both Today (offset 0) and Tomorrow (offset 1).
  const TIMES: { label: string; hhmm: string }[] = [
    { label: "9:30am", hhmm: "09:30" },
    { label: "10am", hhmm: "10:00" },
    { label: "6pm", hhmm: "18:00" },
    { label: "6:20pm", hhmm: "18:20" },
  ];
  const ROWS: { label: string; offset: number }[] = [
    { label: "Today", offset: 0 },
    { label: "Tomorrow", offset: 1 },
  ];

  return (
    <div className="space-y-1">
      {ROWS.map((row) => (
        <div key={row.offset} className="flex items-center gap-1.5">
          <span className="w-16 shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
            {row.label}
          </span>
          <div className="flex flex-wrap gap-1">
            {TIMES.map((t) => (
              <button
                key={t.hhmm}
                type="button"
                onClick={() => onPick(etAt(row.offset, t.hhmm))}
                disabled={disabled}
                className={cn(
                  "inline-flex h-6 items-center rounded-full border border-border bg-background px-2.5 text-[11px] font-medium leading-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  disabled && "cursor-not-allowed opacity-60",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      <p className="text-[10px] text-muted-foreground/70">Times in ET</p>
    </div>
  );
}

function FilterChip({
  label,
  tooltip,
  active,
  onClick,
  disabled,
}: {
  label: string;
  tooltip?: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={tooltip}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-background text-muted-foreground hover:bg-muted",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      {label}
    </button>
  );
}
