"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";

import { useAuth } from "@/components/protected/auth-context";
import { useApiCall } from "@/lib/hooks/use-api-call";

// =============== Types ===============

export type Info = { id: number; name: string; color: string | null };
// A contact group also carries its lifecycle cadence override (0187);
// null means it inherits the org default.
export type ContactGroupInfo = Info & { freeze_cadence_days?: number | null };
// Brands carry their active short domain (from /api/brands/list) so the form
// can gate "API Send" without an extra fetch.
export type BrandOption = Info & { short_domain: string | null };
// Active provider phones across all providers (org-wide, per /api/provider-phones/list).
// Powers the campaign form's "Default send-from number" picker.
export type ActivePhone = {
  id: number;
  // Brand → numbers (1a). NULL = shared, usable by any brand.
  brand_id: number | null;
  phone_number: string;
  number_type: string;
  provider_id: number;
  provider_name: string;
  provider_key: string;
  provider_color: string | null;
  supports_api_send: boolean;
};
export type Offer = Info & {
  payout_model: string;
  payout_cpa: string | null;
  // Brands the offer is assigned to (offer_brands, 0194).
  brand_ids: number[];
};
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
  // Lifecycle chips (PR 4b). Only read when the campaign has
  // lifecycle_rules = true; a legacy campaign's audience is still decided by
  // the four booleans above. The Hot/Warm chip stores BOTH 'hot' and 'warm'.
  lifecycle_statuses: string[];
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
  // Prefill for new stages' provider_phone_id (migration 0115). Null = no
  // default; each stage can still pick its own / override.
  default_provider_phone_id: number | null;
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
  // 869f53efz — parameters of the toggle above, not independent switches.
  offer_cooldown_days: number;
  offer_limit_times: number;
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
  // campaigns.lifecycle_rules for the campaign being edited. Read-only here;
  // the form never sets it.
  lifecycleRules?: boolean;
  // Edit-mode only: gates the audience section as read-only when the
  // campaign has moved past draft.
  currentStatus?: string;
  onSubmitDraft: (values: CampaignFormValues) => Promise<void>;
  onSubmitActivate: (values: CampaignFormValues) => Promise<void>;
  onCancel: () => void;
  isSubmittingDraft: boolean;
  isSubmittingActivate: boolean;
  /** Drip campaigns have no audience source; the activation gate must know. */
  campaignType?: "regular" | "drip";
}

// =============== Constants ===============

export const NONE = "__none__";

export const DEFAULT_FILTERS: AudienceFilters = {
  include_no_status: true,
  include_opt_in: false,
  // Clickers pre-selected on new campaigns (product decision 2026-07-22).
  include_clickers: true,
  include_not_clicked: true,
  // New campaigns start with Cold selected only (owner decision, spec §7.1).
  // Inert until lifecycle_rules is set, which 4c does.
  lifecycle_statuses: ["cold"],
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
    campaignType,
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
  const phonesApi = useApiCall<{ data: ActivePhone[] }>();
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [routingTypes, setRoutingTypes] = useState<Info[]>([]);
  const [trafficTypes, setTrafficTypes] = useState<Info[]>([]);
  const [segments, setSegments] = useState<SegmentInfo[]>([]);
  const [contactGroups, setContactGroups] = useState<ContactGroupInfo[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [activePhones, setActivePhones] = useState<ActivePhone[]>([]);

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
      default_provider_phone_id:
        initialValues?.default_provider_phone_id ?? null,
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
      // Mirror migration 0191's column defaults so a new campaign's form and
      // the row the create route writes start from the same numbers.
      offer_cooldown_days: initialValues?.offer_cooldown_days ?? 7,
      offer_limit_times: initialValues?.offer_limit_times ?? 5,
      link_mode: initialValues?.link_mode ?? "manual",
      start_date: initialValues?.start_date ?? "",
      end_date: initialValues?.end_date ?? "",
    },
  });

  // Watched fields for live enablement + audience preview
  const watchedName = form.watch("name");
  const watchedBrandId = form.watch("brand_id");

  // Brand → numbers (1a): the "Default send-from number" picker only offers
  // numbers usable by the selected brand (its own, plus any shared/NULL-brand
  // number). Re-fetches when the brand changes; with no brand selected it stays
  // org-wide, since there is nothing to scope to yet and the server accepts the
  // pairing in that case too.
  //
  // Server-side filter rather than a client-side one so the list cannot drift
  // from what POST/PATCH will accept — the API is the enforcement, this is the
  // affordance.
  useEffect(() => {
    (async () => {
      const url =
        watchedBrandId != null
          ? `/api/provider-phones/list?brand_id=${watchedBrandId}`
          : "/api/provider-phones/list";
      const r = await phonesApi.execute(url);
      if (r.ok) setActivePhones(r.data.data);
    })();
  }, [phonesApi.execute, watchedBrandId]);
  // The engagement engine's posture. Only 'write' means the lifecycle statuses
  // are current; with it off they are frozen at whenever the job stopped, so a
  // campaign must not select on them. null = not yet known (the form shows the
  // legacy chips until it is, which is the safe direction).
  const [engineMode, setEngineMode] = useState<"off" | "write" | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // ⚠️ Bounded. Without a timeout a hung request parks the form in
        // "checking…" forever, which is a different silent failure from the
        // one this whole change is fixing. 8s then fall back, with the note.
        // ⚠️ NOT /api/settings/lifecycle. That route is manager+ and `null` in
        // the route map, so for an OPERATOR it 403'd every time — the catch
        // below then reported the engine as off to the one role that creates
        // campaigns all day. This asks for the single fact the form needs, on
        // a route the operator may reach.
        const res = await fetch("/api/campaigns/lifecycle-mode", {
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as { lifecycle_rules?: boolean };
        if (!cancelled) setEngineMode(j.lifecycle_rules ? "write" : "off");
      } catch {
        // Fail toward the legacy chips: showing the lifecycle chips when the
        // engine is off invites picking a status nothing maintains.
        //
        // ⚠️ This is NOT a cosmetic fallback, and an earlier comment here said
        // it was. The CREATE route decides lifecycle_rules server-side from the
        // same posture, so a campaign built through the legacy editor while the
        // engine is ON still becomes a lifecycle campaign — with no
        // lifecycle_statuses, which the chip predicate reads as "match nobody".
        // The fallback is tolerable only because it is now rare; before the
        // route change it fired for every operator, every time.
        if (!cancelled) setEngineMode("off");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const watchedLinkMode = form.watch("link_mode");
  const watchedOfferId = form.watch("offer_id");

  // Offer ↔ brand (0194): with a brand selected, the picker lists only offers
  // assigned to it; with none, every offer. A selected offer outside the brand
  // is never cleared silently — it stays in the list, labelled. It's
  // GRANDFATHERED when the pair equals the stored row (edit mode): the server
  // only validates a pair that changed, so that save succeeds.
  const offersForBrand = useMemo(
    () =>
      watchedBrandId == null
        ? offers
        : offers.filter((o) => o.brand_ids.includes(watchedBrandId)),
    [offers, watchedBrandId],
  );
  const selectedOffer = offers.find((o) => o.id === watchedOfferId) ?? null;
  const offerOutOfBrand =
    watchedBrandId != null &&
    selectedOffer != null &&
    !selectedOffer.brand_ids.includes(watchedBrandId);
  const offerOutOfBrandGrandfathered =
    offerOutOfBrand &&
    isEdit &&
    watchedBrandId === (initialValues?.brand_id ?? null) &&
    watchedOfferId === (initialValues?.offer_id ?? null);
  const offerPickerOptions =
    offerOutOfBrand && selectedOffer
      ? [
          {
            ...selectedOffer,
            name: `${selectedOffer.name} (not assigned to this brand)`,
          },
          ...offersForBrand,
        ]
      : offersForBrand;
  const brandHasNoOffers =
    watchedBrandId != null && offersForBrand.length === 0;

  const watchedSegments = form.watch("audience_segment_ids");
  const watchedExcludeSegments = form.watch("audience_exclude_segment_ids");
  const watchedContactGroups = form.watch("audience_contact_group_ids");

  // campaigns.lifecycle_rules. Deliberately not something the form can toggle:
  // in EDIT mode it is whatever the campaign was created as, and in CREATE
  // mode it is what the create route WILL decide — which is the engine's
  // posture, read here so the form shows the chips the new campaign will
  // actually get rather than guessing false and changing after save.
  //
  // ⚠️ The route re-reads the engine inside its own transaction and does NOT
  // trust this value. This is a preview of its decision, not the decision.
  const lifecycleRulesFromLoad =
    props.mode === "create"
      ? engineMode === "write"
      : props.lifecycleRules === true;

  // ⚠️ In CREATE mode the answer is NOT KNOWN until the engine read lands, and
  // "not known" is a third state — not a quiet "legacy". Rendering the legacy
  // path while this is true is the bug this flag exists to prevent: the form
  // showed read-only chips and the old Filters row with no explanation for as
  // long as the fetch took (reproduced on production 2026-09-25 by delaying
  // the response — a cold serverless function does it for free).
  //
  // EDIT mode never pends: the campaign's own flag is already loaded, and the
  // engine's current posture cannot change what that campaign is.
  const lifecycleDecisionPending =
    props.mode === "create" && engineMode === null;

  // The effective freeze cadence of each selected group: its own override,
  // or undefined when it inherits the org default (the note then says so
  // rather than inventing a number).
  const selectedGroupCadences = (watchedContactGroups ?? [])
    .map((id) => contactGroups.find((g) => g.id === id)?.freeze_cadence_days)
    .filter((d): d is number => typeof d === "number" && d > 0);
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
    if (offersForBrand.length === 1 && form.getValues("offer_id") === null) {
      form.setValue("offer_id", offersForBrand[0].id, { shouldDirty: false });
    }
  }, [isEdit, offersForBrand, form]);
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
  const [previewOfferExposed, setPreviewOfferExposed] = useState<number | null>(
    null,
  );
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

  // The offer-rule parameters ("Not within N days" / "Not more than N times")
  // as last COMMITTED by the operator: on Enter or when the field loses focus,
  // never per keystroke. ⚠️ They were read with form.getValues() inside the
  // preview effect but were in none of its keys, so editing them did not
  // recalculate the audience until some other input changed (2026-10-01).
  const [committedOfferRules, setCommittedOfferRules] = useState(() => ({
    cooldownDays: form.getValues("offer_cooldown_days"),
    limitTimes: form.getValues("offer_limit_times"),
  }));
  const commitOfferRules = () => {
    const cooldownDays = form.getValues("offer_cooldown_days");
    const limitTimes = form.getValues("offer_limit_times");
    setCommittedOfferRules((prev) =>
      prev.cooldownDays === cooldownDays && prev.limitTimes === limitTimes
        ? prev
        : { cooldownDays, limitTimes },
    );
  };
  const offerRulesKey = `${committedOfferRules.cooldownDays}:${committedOfferRules.limitTimes}`;

  // ── The audience preview: single-flight, latest wins, one automatic retry ──
  //
  // ⚠️ HOTFIX 2026-10-01. The preview of a real segment recipe takes 40-100 s,
  // so the old design (abort the superseded request on every edit) did not
  // help: aborting the HTTP request never cancels the Postgres query behind it,
  // so every edit left another long query burning. Now:
  //   * at most ONE preview request per form is in flight;
  //   * edits made while it runs mark it stale, and when it returns its result
  //     is dropped and ONE new request runs with the latest values;
  //   * a timeout, a server error, a gateway timeout or a dropped connection is
  //     retried automatically once; "still running" (409, the server's
  //     per-user single-flight lock) is waited out and retried;
  //   * retryPreview() re-runs it on demand, so a failed preview is never a
  //     dead end that needs the campaign recreated.
  // Superseded by T5/T6 (two-part preview, database-side cancellation).
  const previewBodyRef = useRef<string | null>(null);
  const previewInFlightRef = useRef(false);
  const previewStaleRef = useRef(false);
  const previewUnmountedRef = useRef(false);
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const clearPreviewNumbers = () => {
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
  };
  const runPreviewRef = useRef<(attempt: number) => Promise<void>>(
    async () => {},
  );
  runPreviewRef.current = async (attempt: number) => {
    const body = previewBodyRef.current;
    if (!body) {
      setPreviewLoading(false);
      return;
    }
    if (previewInFlightRef.current) {
      previewStaleRef.current = true;
      return;
    }
    if (previewRetryTimerRef.current) {
      clearTimeout(previewRetryTimerRef.current);
      previewRetryTimerRef.current = null;
    }
    previewInFlightRef.current = true;
    previewStaleRef.current = false;
    setPreviewLoading(true);
    setPreviewError(null);
    const ac = new AbortController();
    previewAbortRef.current = ac;
    const result = await previewApi.execute("/api/campaigns/audience-preview", {
      method: "POST",
      // Aborted only when the form unmounts — never because an input changed.
      signal: ac.signal,
      headers: { "Content-Type": "application/json" },
      body,
    });
    previewInFlightRef.current = false;
    previewAbortRef.current = null;
    if (previewUnmountedRef.current) return;
    // Superseded while it ran: drop this answer, ask again with the latest.
    if (previewStaleRef.current || body !== previewBodyRef.current) {
      void runPreviewRef.current(0);
      return;
    }
    if (result.ok) {
      setPreviewLoading(false);
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
      return;
    }
    const reason = (result.details as { reason?: string } | undefined)?.reason;
    const busy = result.status === 409 && reason === "preview_busy";
    const transient =
      result.status === 0 ||
      result.status >= 500 ||
      reason === "preview_timeout";
    if ((busy && attempt < 12) || (transient && attempt < 1)) {
      previewRetryTimerRef.current = setTimeout(
        () => {
          previewRetryTimerRef.current = null;
          void runPreviewRef.current(attempt + 1);
        },
        busy ? 10_000 : 2_000,
      );
      return;
    }
    setPreviewLoading(false);
    clearPreviewNumbers();
    setPreviewError(result.error);
  };
  // Re-run the preview on demand (the "Retry preview" button).
  const retryPreview = () => {
    void runPreviewRef.current(0);
  };

  useEffect(() => {
    if (watchedSegments.length === 0 && watchedContactGroups.length === 0) {
      previewBodyRef.current = null;
      clearPreviewNumbers();
      setPreviewError(null);
      return;
    }
    previewBodyRef.current = JSON.stringify({
      audience_segment_ids: watchedSegments,
      audience_exclude_segment_ids: watchedExcludeSegments,
      audience_contact_group_ids: watchedContactGroups,
      audience_filters: watchedFilters,
      audience_cap: watchedCap,
      exclude_in_use_contacts: watchedExcludeInUse,
      exclude_prior_offer_contacts: watchedExcludePriorOffer,
      offer_cooldown_days: committedOfferRules.cooldownDays,
      offer_limit_times: committedOfferRules.limitTimes,
      offer_id: watchedOfferId,
    });
    // A pending automatic retry is for values that no longer apply.
    if (previewRetryTimerRef.current) {
      clearTimeout(previewRetryTimerRef.current);
      previewRetryTimerRef.current = null;
    }
    const t = setTimeout(() => void runPreviewRef.current(0), 500);
    return () => clearTimeout(t);
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
    offerRulesKey,
    previewApi.execute,
  ]);

  useEffect(() => {
    // Reset on (re)mount: React StrictMode mounts, unmounts and remounts in
    // dev, and a flag left true by the simulated unmount dropped every later
    // result, leaving the panel on "Calculating…" for good.
    previewUnmountedRef.current = false;
    return () => {
      previewUnmountedRef.current = true;
      previewAbortRef.current?.abort();
      if (previewRetryTimerRef.current) clearTimeout(previewRetryTimerRef.current);
    };
  }, []);

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
  // ⚠️ A drip campaign has no audience source and never will — requiring one
  // here left the Activate button permanently disabled with a hint naming a
  // field the form no longer shows.
  const isDrip = campaignType === "drip";
  const activateReady =
    !!watchedName.trim() &&
    watchedBrandId !== null &&
    watchedOfferId !== null &&
    (isDrip || hasAudienceSource) &&
    !dateError;
  const activateBlockedReason = dateError
    ? dateError
    : !activateReady
      ? isDrip
        ? "Fill in name, brand and offer to activate."
        : "Fill in name, brand, offer, and at least one contact group to activate."
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

  // Lifecycle chips (PR 4b). Toggling a chip rewrites the whole
  // lifecycle_statuses array, because the Hot/Warm chip owns TWO values —
  // toggling one key at a time could leave 'hot' set and 'warm' clear, which no
  // chip can represent.
  function toggleLifecycleChip(values: readonly string[], on: boolean) {
    const current = new Set(
      (form.getValues("audience_filters")?.lifecycle_statuses ??
        []) as string[],
    );
    for (const v of values) {
      if (on) current.add(v);
      else current.delete(v);
    }
    form.setValue(
      "audience_filters",
      {
        ...form.getValues("audience_filters"),
        lifecycle_statuses: [...current],
      },
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
    offerPickerOptions,
    offerOutOfBrand,
    offerOutOfBrandGrandfathered,
    brandHasNoOffers,
    routingTypes,
    trafficTypes,
    segments,
    contactGroups,
    contactGroupsLoading: contactGroupsApi.isLoading,
    members,
    activePhones,
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
    retryPreview,
    commitOfferRules,
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
    toggleLifecycleChip,
    // campaigns.lifecycle_rules. False for every campaign today; the create
    // route does not set it until PR 4c.
    lifecycleRules: lifecycleRulesFromLoad,
    engineMode,
    lifecycleDecisionPending,
    // The effective freeze cadence of each SELECTED group: its override, else
    // the org default. Drives the Freeze chip's helper note.
    selectedGroupCadences,
    setCarrierFilter,
    handleDraftClick,
    handleActivateClick,
    onCancel,
  };
}

export type CampaignFormState = ReturnType<typeof useCampaignFormState>;
