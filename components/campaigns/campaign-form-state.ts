"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";

import { useAuth } from "@/components/protected/auth-context";
import { useApiCall } from "@/lib/hooks/use-api-call";

// =============== Types ===============

export type Info = { id: number; name: string; color: string | null };
// Brands carry their active short domain (from /api/brands/list) so the form
// can gate "API Send" without an extra fetch.
export type BrandOption = Info & { short_domain: string | null };
export type Offer = Info & { payout_model: string; payout_cpa: string | null };
export type SegmentInfo = {
  id: number;
  name: string;
  segment_id: string;
  stats: { total_count: number };
  active_rules_count?: number;
};
export type Member = {
  id: string;
  email: string | null;
  display_name: string | null;
};

export interface AudienceFilters {
  include_no_status: boolean;
  include_opt_in: boolean;
  include_clickers: boolean;
  include_not_clicked: boolean;
  // Optional carrier allow-list (migration 0098). Empty = no carrier filter.
  // When non-empty, only contacts whose carrier_norm is in the set qualify;
  // Unidentified (never looked up) is always excluded once a filter is set.
  carrier_filter: string[];
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
  // Per-segment exclude set (migration 0114). Disjoint from audience_segment_ids
  // (the include set). Members are subtracted from the positive base.
  audience_exclude_segment_ids: number[];
  audience_contact_group_ids: number[];
  audience_filters: AudienceFilters;
  // Null = no cap. The form represents an empty input as null.
  audience_cap: number | null;
  // Exclude contacts already in use by another active campaign. On by
  // default for new campaigns.
  exclude_in_use_contacts: boolean;
  // Exclude leads who already received this offer in a previous campaign
  // (Phase-2 content dedup, LAYER 3). Off by default; opt-in per campaign.
  exclude_prior_offer_contacts: boolean;
  // Send method: 'manual' (pasted Short URL) or 'tracked' (API Send — mints a
  // per-recipient link). 'tracked' requires the brand to have an active short
  // domain (gated in the UI + on the server).
  link_mode: "manual" | "tracked";
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

// =============== Constants ===============

export const NONE = "__none__";

export const DEFAULT_FILTERS: AudienceFilters = {
  include_no_status: true,
  include_opt_in: false,
  // Clickers pre-selected on new campaigns (product decision 2026-07-22).
  include_clickers: true,
  include_not_clicked: true,
  carrier_filter: [],
};

// =============== Hook ===============

export function useCampaignFormState(props: CampaignFormProps) {
  const {
    mode,
    initialValues,
    currentStatus,
    onSubmitDraft,
    onSubmitActivate,
    onCancel,
    isSubmittingDraft,
    isSubmittingActivate,
  } = props;

  const isEdit = mode === "edit";
  const audienceLocked =
    isEdit && currentStatus !== undefined && currentStatus !== "draft";
  const { auth } = useAuth();

  // Reference data
  const brandsApi = useApiCall<{ data: BrandOption[] }>();
  const offersApi = useApiCall<{ data: Offer[] }>();
  const routingApi = useApiCall<{ data: Info[] }>();
  const trafficApi = useApiCall<{ data: Info[] }>();
  const segmentsApi = useApiCall<{ data: SegmentInfo[] }>();
  const contactGroupsApi = useApiCall<{ data: Info[] }>();
  const membersApi = useApiCall<{ data: Member[] }>();
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [routingTypes, setRoutingTypes] = useState<Info[]>([]);
  const [trafficTypes, setTrafficTypes] = useState<Info[]>([]);
  const [segments, setSegments] = useState<SegmentInfo[]>([]);
  const [contactGroups, setContactGroups] = useState<Info[]>([]);
  const [members, setMembers] = useState<Member[]>([]);

  useEffect(() => {
    (async () => {
      const r = await brandsApi.execute("/api/brands/list?pageSize=200");
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
      const r = await contactGroupsApi.execute(
        "/api/contact-groups/list?pageSize=500&sortBy=name&sortDir=asc",
      );
      if (r.ok) setContactGroups(r.data.data);
    })();
  }, [contactGroupsApi.execute]);
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
      audience_exclude_segment_ids:
        initialValues?.audience_exclude_segment_ids ?? [],
      audience_contact_group_ids:
        initialValues?.audience_contact_group_ids ?? [],
      audience_filters: initialValues?.audience_filters ?? DEFAULT_FILTERS,
      audience_cap: initialValues?.audience_cap ?? null,
      // Default ON for new campaigns; edit mode loads the stored value
      // (?? leaves an explicit false intact).
      exclude_in_use_contacts: initialValues?.exclude_in_use_contacts ?? true,
      exclude_prior_offer_contacts:
        initialValues?.exclude_prior_offer_contacts ?? false,
      link_mode: initialValues?.link_mode ?? "manual",
      start_date: initialValues?.start_date ?? "",
      end_date: initialValues?.end_date ?? "",
    },
  });

  // Watched fields for live enablement + audience preview
  const watchedName = form.watch("name");
  const watchedBrandId = form.watch("brand_id");
  const watchedLinkMode = form.watch("link_mode");
  const watchedOfferId = form.watch("offer_id");
  const watchedSegments = form.watch("audience_segment_ids");
  const watchedExcludeSegments = form.watch("audience_exclude_segment_ids");
  const watchedContactGroups = form.watch("audience_contact_group_ids");
  const watchedFilters = form.watch("audience_filters");
  const watchedCap = form.watch("audience_cap");
  const watchedExcludeInUse = form.watch("exclude_in_use_contacts");
  const watchedExcludePriorOffer = form.watch("exclude_prior_offer_contacts");
  const watchedStart = form.watch("start_date");
  const watchedEnd = form.watch("end_date");

  // Auto-select dropdowns that resolve to exactly one option when
  // *creating* a new campaign. Edit mode is skipped — the existing
  // record's choice (even null on a stale draft) wins, per the user's
  // "when creating" scope. shouldDirty: false so an auto-fill doesn't
  // trigger the "discard unsaved changes?" prompt on cancel.
  useEffect(() => {
    if (isEdit) return;
    if (brands.length === 1 && form.getValues("brand_id") === null) {
      form.setValue("brand_id", brands[0].id, { shouldDirty: false });
    }
  }, [isEdit, brands, form]);
  useEffect(() => {
    if (isEdit) return;
    if (offers.length === 1 && form.getValues("offer_id") === null) {
      form.setValue("offer_id", offers[0].id, { shouldDirty: false });
    }
  }, [isEdit, offers, form]);
  useEffect(() => {
    if (isEdit) return;
    if (
      routingTypes.length === 1 &&
      form.getValues("routing_type_id") === null
    ) {
      form.setValue("routing_type_id", routingTypes[0].id, {
        shouldDirty: false,
      });
    }
  }, [isEdit, routingTypes, form]);
  // Default new campaigns to the "Preland" routing type when it exists.
  // Guarded on null so it composes with the single-option auto-select above
  // and never overrides an existing draft's saved value. Falls back to None
  // (null) if no such type is configured.
  useEffect(() => {
    if (isEdit) return;
    if (routingTypes.length === 0) return;
    if (form.getValues("routing_type_id") !== null) return;
    const preland = routingTypes.find(
      (r) => r.name.trim().toLowerCase() === "preland",
    );
    if (preland) {
      form.setValue("routing_type_id", preland.id, { shouldDirty: false });
    }
  }, [isEdit, routingTypes, form]);
  useEffect(() => {
    if (isEdit) return;
    if (
      trafficTypes.length === 1 &&
      form.getValues("traffic_type_id") === null
    ) {
      form.setValue("traffic_type_id", trafficTypes[0].id, {
        shouldDirty: false,
      });
    }
  }, [isEdit, trafficTypes, form]);
  useEffect(() => {
    if (isEdit) return;
    if (
      segments.length === 1 &&
      form.getValues("audience_segment_ids").length === 0
    ) {
      form.setValue("audience_segment_ids", [segments[0].id], {
        shouldDirty: false,
      });
    }
  }, [isEdit, segments, form]);
  useEffect(() => {
    if (isEdit) return;
    if (
      contactGroups.length === 1 &&
      form.getValues("audience_contact_group_ids").length === 0
    ) {
      form.setValue("audience_contact_group_ids", [contactGroups[0].id], {
        shouldDirty: false,
      });
    }
  }, [isEdit, contactGroups, form]);

  // Audience preview, debounced. Tracks its own cancel signal so a fast
  // toggle doesn't apply a stale count. The endpoint returns the full
  // composition breakdown so the right-rail panel can show how segments
  // vs groups vs overlap contribute to the post-cap count.
  const previewApi = useApiCall<{
    count: number;
    total_matching: number;
    applied_cap: number | null;
    from_segments: number;
    from_groups: number;
    overlap: number;
    excluded_by_segments: number;
    excluded_for_optout: number;
    in_use_in_other_campaigns: number;
    got_offer_in_prior_campaign: number;
    carrier_removed: Record<string, number>;
  }>();
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewTotalMatching, setPreviewTotalMatching] = useState<
    number | null
  >(null);
  const [previewFromSegments, setPreviewFromSegments] = useState<number | null>(
    null,
  );
  const [previewFromGroups, setPreviewFromGroups] = useState<number | null>(
    null,
  );
  const [previewOverlap, setPreviewOverlap] = useState<number | null>(null);
  const [previewExcludedBySegments, setPreviewExcludedBySegments] = useState<
    number | null
  >(null);
  const [previewExcludedOptOut, setPreviewExcludedOptOut] = useState<
    number | null
  >(null);
  const [previewInUseElsewhere, setPreviewInUseElsewhere] = useState<
    number | null
  >(null);
  // Leads in the audience who already got this offer (content-dedup LAYER 3).
  // Only nonzero when the exclude-prior-offer toggle is on.
  const [previewOfferExposed, setPreviewOfferExposed] = useState<
    number | null
  >(null);
  // Per-bucket counts removed by the carrier filter (bucket → count).
  // "Unidentified" is its own key (never-looked-up numbers). Empty when no
  // carrier filter is active.
  const [previewCarrierRemoved, setPreviewCarrierRemoved] = useState<
    Record<string, number>
  >({});
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const segmentsKey = watchedSegments.join(",");
  const excludeSegmentsKey = watchedExcludeSegments.join(",");
  const groupsKey = watchedContactGroups.join(",");
  const filtersKey = JSON.stringify(watchedFilters);
  const capKey = watchedCap ?? "";
  const excludeInUseKey = watchedExcludeInUse ? "1" : "0";
  const excludePriorOfferKey = watchedExcludePriorOffer ? "1" : "0";
  const offerKey = watchedOfferId ?? "";

  useEffect(() => {
    if (
      watchedSegments.length === 0 &&
      watchedContactGroups.length === 0
    ) {
      setPreviewCount(null);
      setPreviewTotalMatching(null);
      setPreviewFromSegments(null);
      setPreviewFromGroups(null);
      setPreviewOverlap(null);
      setPreviewExcludedBySegments(null);
      setPreviewExcludedOptOut(null);
      setPreviewInUseElsewhere(null);
      setPreviewOfferExposed(null);
      setPreviewCarrierRemoved({});
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
            audience_exclude_segment_ids: watchedExcludeSegments,
            audience_contact_group_ids: watchedContactGroups,
            audience_filters: watchedFilters,
            audience_cap: watchedCap,
            exclude_in_use_contacts: watchedExcludeInUse,
            exclude_prior_offer_contacts: watchedExcludePriorOffer,
            offer_id: watchedOfferId,
          }),
        },
      );
      if (cancelled) return;
      setPreviewLoading(false);
      if (result.ok) {
        setPreviewCount(result.data.count);
        setPreviewTotalMatching(result.data.total_matching);
        setPreviewFromSegments(result.data.from_segments);
        setPreviewFromGroups(result.data.from_groups);
        setPreviewOverlap(result.data.overlap);
        setPreviewExcludedBySegments(result.data.excluded_by_segments);
        setPreviewExcludedOptOut(result.data.excluded_for_optout);
        setPreviewInUseElsewhere(result.data.in_use_in_other_campaigns);
        setPreviewOfferExposed(result.data.got_offer_in_prior_campaign);
        setPreviewCarrierRemoved(result.data.carrier_removed ?? {});
        setPreviewError(null);
      } else {
        setPreviewError(result.error);
        setPreviewCount(null);
        setPreviewTotalMatching(null);
        setPreviewFromSegments(null);
        setPreviewFromGroups(null);
        setPreviewOverlap(null);
        setPreviewExcludedBySegments(null);
        setPreviewExcludedOptOut(null);
        setPreviewInUseElsewhere(null);
        setPreviewOfferExposed(null);
        setPreviewCarrierRemoved({});
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // segmentsKey / groupsKey / filtersKey / capKey / excludeInUseKey /
    // excludePriorOfferKey / offerKey collapse identity to stable primitives
    // so this only re-runs on real change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    segmentsKey,
    excludeSegmentsKey,
    groupsKey,
    filtersKey,
    capKey,
    excludeInUseKey,
    excludePriorOfferKey,
    offerKey,
    previewApi.execute,
  ]);

  // Date sanity (purely client-side hint; the server doesn't refuse
  // end<start because either field can be null).
  const dateError =
    watchedStart && watchedEnd && watchedEnd < watchedStart
      ? "End date can't be before start date"
      : null;

  // Drafts are a scratchpad — always saveable. Activation requires the
  // launch invariants (name + brand + offer + at least one contact
  // group). Segments are optional — they widen the audience when
  // present but a campaign can launch with just a contact-group pool.
  const draftReady = !dateError;
  const hasAudienceSource = watchedContactGroups.length > 0;
  const activateReady =
    !!watchedName.trim() &&
    watchedBrandId !== null &&
    watchedOfferId !== null &&
    hasAudienceSource &&
    !dateError;
  const activateBlockedReason = dateError
    ? dateError
    : !activateReady
      ? "Fill in name, brand, offer, and at least one contact group to activate."
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

  // The SegmentPicker's value is the UNION of include + exclude ids; the mode
  // map (migration 0114) tells it how to render each chip. New selections
  // default to include.
  const segmentPickerValue = useMemo(
    () => [...watchedSegments, ...watchedExcludeSegments],
    [watchedSegments, watchedExcludeSegments],
  );
  const segmentModes = useMemo(() => {
    const m: Record<number, "include" | "exclude"> = {};
    for (const id of watchedSegments) m[id] = "include";
    for (const id of watchedExcludeSegments) m[id] = "exclude";
    return m;
  }, [watchedSegments, watchedExcludeSegments]);

  // Selection changed in the picker: keep each still-selected id's current
  // mode; brand-new ids join the include set; dropped ids leave both.
  function onSegmentSelectionChange(next: number[]) {
    const nextSet = new Set(next);
    const include = form
      .getValues("audience_segment_ids")
      .filter((id) => nextSet.has(id));
    const exclude = form
      .getValues("audience_exclude_segment_ids")
      .filter((id) => nextSet.has(id));
    const known = new Set([...include, ...exclude]);
    for (const id of next) if (!known.has(id)) include.push(id);
    form.setValue("audience_segment_ids", include, { shouldDirty: true });
    form.setValue("audience_exclude_segment_ids", exclude, {
      shouldDirty: true,
    });
  }

  // Flip a selected segment between include and exclude.
  function onToggleSegmentMode(id: number) {
    const include = form.getValues("audience_segment_ids");
    const exclude = form.getValues("audience_exclude_segment_ids");
    if (include.includes(id)) {
      form.setValue(
        "audience_segment_ids",
        include.filter((x) => x !== id),
        { shouldDirty: true },
      );
      form.setValue("audience_exclude_segment_ids", [...exclude, id], {
        shouldDirty: true,
      });
    } else if (exclude.includes(id)) {
      form.setValue(
        "audience_exclude_segment_ids",
        exclude.filter((x) => x !== id),
        { shouldDirty: true },
      );
      form.setValue("audience_segment_ids", [...include, id], {
        shouldDirty: true,
      });
    }
  }

  // The selected brand's active short domain (null if none) — gates API Send.
  const selectedBrandShortDomain = useMemo(
    () => brands.find((b) => b.id === watchedBrandId)?.short_domain ?? null,
    [brands, watchedBrandId],
  );

  // Tracks whether the operator has manually picked a send method. Once they
  // have, we stop auto-selecting API Send on brand changes (respect the
  // override). Stays false for auto-fills so brand switching keeps working.
  const linkModeTouchedRef = useRef(false);

  function setLinkMode(mode: "manual" | "tracked") {
    linkModeTouchedRef.current = true;
    form.setValue("link_mode", mode, { shouldDirty: true });
  }

  // Auto-select API Send once a brand with an active short domain is chosen
  // (create mode only). Skipped after the operator manually touches the field.
  // shouldDirty:false so the auto-fill doesn't trip the discard prompt.
  useEffect(() => {
    if (isEdit) return;
    if (linkModeTouchedRef.current) return;
    if (selectedBrandShortDomain && watchedLinkMode !== "tracked") {
      form.setValue("link_mode", "tracked", { shouldDirty: false });
    }
  }, [isEdit, selectedBrandShortDomain, watchedLinkMode, form]);

  // Keep API Send valid: if the (selected) brand has no active short domain,
  // force back to Manual so a tracked campaign can't be submitted without a
  // mintable link. shouldDirty:false so it doesn't trip the discard prompt.
  useEffect(() => {
    if (watchedLinkMode === "tracked" && !selectedBrandShortDomain) {
      form.setValue("link_mode", "manual", { shouldDirty: false });
    }
  }, [watchedLinkMode, selectedBrandShortDomain, form]);

  function setFilter(
    key: Exclude<keyof AudienceFilters, "carrier_filter">,
    value: boolean,
  ) {
    form.setValue(
      "audience_filters",
      { ...form.getValues("audience_filters"), [key]: value },
      { shouldDirty: true },
    );
  }

  function setCarrierFilter(next: string[]) {
    form.setValue(
      "audience_filters",
      { ...form.getValues("audience_filters"), carrier_filter: next },
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

  return {
    isEdit,
    audienceLocked,
    form,
    brands,
    offers,
    routingTypes,
    trafficTypes,
    segments,
    contactGroups,
    contactGroupsLoading: contactGroupsApi.isLoading,
    members,
    watchedFilters,
    watchedSegments,
    watchedExcludeSegments,
    segmentPickerValue,
    segmentModes,
    onSegmentSelectionChange,
    onToggleSegmentMode,
    watchedContactGroups,
    watchedCap,
    watchedExcludeInUse,
    watchedExcludePriorOffer,
    watchedLinkMode,
    selectedBrandShortDomain,
    setLinkMode,
    previewCount,
    previewTotalMatching,
    previewFromSegments,
    previewFromGroups,
    previewOverlap,
    previewExcludedBySegments,
    previewExcludedOptOut,
    previewInUseElsewhere,
    previewOfferExposed,
    previewCarrierRemoved,
    previewError,
    previewLoading,
    hasAudienceSource,
    dateError,
    draftReady,
    activateReady,
    activateBlockedReason,
    anySubmitting,
    isSubmittingDraft,
    isSubmittingActivate,
    segmentSearch,
    setSegmentSearch,
    filteredSegments,
    toggleSegment,
    setFilter,
    setCarrierFilter,
    handleDraftClick,
    handleActivateClick,
    onCancel,
  };
}

export type CampaignFormState = ReturnType<typeof useCampaignFormState>;
