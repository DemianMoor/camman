"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { isEntityAvailable } from "@/lib/feature-flags";
import { cn } from "@/lib/utils";
import {
  CAMPAIGN_USE_PERIODS,
  CARRIER_VALUES,
  getValueShapeForRuleType,
  isCampaignUsePeriod,
  isStringSubsetOf,
  isValidOperatorForRuleType,
  PHONE_TYPE_VALUES,
  RULE_TYPES,
  RULE_TYPE_KEYS,
  type RuleType,
  type ValueShape,
} from "@/lib/validators/segment-rule-types";

// Display labels for the phone_type set editor. Carrier codes are shown as-is.
const PHONE_TYPE_LABELS: Record<string, string> = {
  mobile: "Mobile",
  voip: "VoIP",
  toll_free: "Toll-free",
  unknown: "Unknown",
};

type RefInfo = { id: number; name: string; color: string | null } | null;

export type SegmentRule = {
  id: number;
  segment_id: number;
  rule_type: RuleType;
  operator: "is" | "is_not";
  value: unknown;
  position: number;
  is_active: boolean;
  combinator: "and" | "or";
  created_at: string;
  updated_at: string;
  ref: RefInfo;
};

type RulesResponse = { data: SegmentRule[] };

type PreviewResponse = {
  count: number | null;
  manual_count: number;
  rule_filtered_count: number | null;
  duration_ms: number;
  truncated: boolean;
};

type PickerOption = { id: number; name: string; color: string | null };

const PREVIEW_DEBOUNCE_MS = 600;

export interface RulesPanelProps {
  segmentId: number;
  currentSegmentDbId: number;
  canEdit: boolean;
  manualCount: number;
  onRuleFilteredCountChanged?: (count: number | null) => void;
}

// Picks the right value shape for a rule type. Used both for rendering the
// value control and for validating client-side before the PATCH.
function valueShapeFor(ruleType: string): ValueShape | null {
  return getValueShapeForRuleType(ruleType);
}

// Snap an unknown `value` to a usable form for a given rule type. Used
// when the user switches rule_type — we don't want to keep a brand_id
// around when the new shape is `none` or `positive_integer`.
function coerceValueForShape(
  shape: ValueShape | null,
  prior: unknown,
): unknown {
  if (shape === "none") return null;
  if (shape === "positive_integer") {
    if (typeof prior === "number" && Number.isInteger(prior) && prior >= 1) {
      return prior;
    }
    return 1;
  }
  if (shape === "campaign_use_period") {
    return isCampaignUsePeriod(prior) ? prior : "1w";
  }
  if (shape === "phone_type_set") {
    return isStringSubsetOf(prior, PHONE_TYPE_VALUES) ? prior : [];
  }
  if (shape === "carrier_set") {
    return isStringSubsetOf(prior, CARRIER_VALUES) ? prior : [];
  }
  if (
    shape === "brand_id" ||
    shape === "offer_id" ||
    shape === "segment_id" ||
    shape === "contact_group_id"
  ) {
    return typeof prior === "number" ? prior : null;
  }
  return null;
}

// Whether the rule is fully specified enough to PATCH to the server. The
// server re-validates, but we don't hit it with obvious nonsense.
//
// FK shapes accept null — that's an "incomplete" rule (the rule_type has
// changed but the user hasn't picked a value yet). The eval skips
// incomplete rules so the audience is unaffected; persisting the
// rule_type change is what lets it survive tab switches.
function isRuleReadyToSave(
  ruleType: string,
  operator: string,
  value: unknown,
): boolean {
  const shape = valueShapeFor(ruleType);
  if (!shape) return false;
  if (!isValidOperatorForRuleType(ruleType, operator)) return false;
  if (shape === "none") return value === null || value === undefined;
  if (shape === "positive_integer") {
    return (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 36500
    );
  }
  if (shape === "campaign_use_period") return isCampaignUsePeriod(value);
  // Set shapes require a non-empty valid array (no "incomplete" state is
  // accepted server-side); an empty set stays local and doesn't PATCH.
  if (shape === "phone_type_set") return isStringSubsetOf(value, PHONE_TYPE_VALUES);
  if (shape === "carrier_set") return isStringSubsetOf(value, CARRIER_VALUES);
  if (value === null || value === undefined) return true;
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

// True when a rule's value isn't yet a valid pick for its rule_type's
// FK shape. We persist such rules but flag them in the UI so the user
// knows they need to finish picking before the rule affects audience.
function isRuleIncomplete(
  ruleType: string,
  value: unknown,
): boolean {
  const shape = valueShapeFor(ruleType);
  if (!shape) return false;
  if (
    shape === "none" ||
    shape === "positive_integer" ||
    shape === "campaign_use_period"
  ) {
    return false;
  }
  if (shape === "phone_type_set" || shape === "carrier_set") {
    return !Array.isArray(value) || value.length === 0;
  }
  return value === null || value === undefined;
}

export function RulesPanel({
  segmentId,
  currentSegmentDbId,
  canEdit,
  manualCount,
  onRuleFilteredCountChanged,
}: RulesPanelProps) {
  const listApi = useApiCall<RulesResponse>();
  const createApi = useApiCall<SegmentRule>();
  const previewApi = useApiCall<PreviewResponse>();

  // FK picker option fetches. Eager (on mount) — lazy gating used to live
  // here, but it deadlocked: the "do we need this picker?" condition was
  // derived from the parent's `rules` array, which only updates after a
  // successful PATCH, which can't happen until the picker has options to
  // pick from. Eager is cheap (each list is ≤500 rows) and removes the
  // class of timing bugs.
  const brandsApi = useApiCall<{ data: PickerOption[] }>();
  const offersApi = useApiCall<{ data: PickerOption[] }>();
  const segmentsApi = useApiCall<{ data: PickerOption[] }>();
  const contactGroupsApi = useApiCall<{ data: PickerOption[] }>();
  const [brands, setBrands] = useState<PickerOption[]>([]);
  const [offers, setOffers] = useState<PickerOption[]>([]);
  const [segmentsList, setSegmentsList] = useState<PickerOption[]>([]);
  const [contactGroupOptions, setContactGroupOptions] = useState<
    PickerOption[]
  >([]);
  // Per-picker loaded flags. `true` after fetch resolves (regardless of
  // result count) OR when the entity isn't enabled by feature flag.
  const [brandsLoaded, setBrandsLoaded] = useState(false);
  const [offersLoaded, setOffersLoaded] = useState(false);
  const [segmentsLoaded, setSegmentsLoaded] = useState(false);
  const [contactGroupsLoaded, setContactGroupsLoaded] = useState(false);

  const [rules, setRules] = useState<SegmentRule[]>([]);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [rulesTick, setRulesTick] = useState(0);
  const refetchRules = useCallback(() => setRulesTick((n) => n + 1), []);

  // Preview state.
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Initial rules load.
  useEffect(() => {
    if (!Number.isInteger(segmentId) || segmentId <= 0) return;
    let cancelled = false;
    setRulesError(null);
    (async () => {
      const r = await listApi.execute(`/api/segments/${segmentId}/rules`);
      if (cancelled) return;
      if (r.ok) setRules(r.data.data);
      else setRulesError(r.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [segmentId, rulesTick, listApi.execute]);

  // Eager FK option fetches, fire-once on mount. Each marks its `loaded`
  // flag in a finally-like step so the UI can distinguish "still loading"
  // from "loaded with zero options" (which deserves a different message).
  useEffect(() => {
    let cancelled = false;
    if (!isEntityAvailable("brands")) {
      setBrandsLoaded(true);
      return;
    }
    (async () => {
      const r = await brandsApi.execute("/api/brands/list?pageSize=500");
      if (cancelled) return;
      if (r.ok) setBrands(r.data.data);
      setBrandsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [brandsApi.execute]);

  useEffect(() => {
    let cancelled = false;
    if (!isEntityAvailable("offers")) {
      setOffersLoaded(true);
      return;
    }
    (async () => {
      const r = await offersApi.execute("/api/offers/list?pageSize=500");
      if (cancelled) return;
      if (r.ok) setOffers(r.data.data);
      setOffersLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [offersApi.execute]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await segmentsApi.execute("/api/segments/list?pageSize=500");
      if (cancelled) return;
      // Exclude the current segment to prevent obvious self-reference loops.
      // Server-side also rejects self-reference (see
      // lib/api/segment-rule-value-ownership.ts) — this is just UI polish.
      if (r.ok) {
        setSegmentsList(
          r.data.data.filter((s) => s.id !== currentSegmentDbId),
        );
      }
      setSegmentsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentSegmentDbId, segmentsApi.execute]);

  useEffect(() => {
    let cancelled = false;
    if (!isEntityAvailable("contact_groups")) {
      setContactGroupsLoaded(true);
      return;
    }
    (async () => {
      const r = await contactGroupsApi.execute(
        "/api/contact-groups/list?pageSize=500",
      );
      if (cancelled) return;
      if (r.ok) setContactGroupOptions(r.data.data);
      setContactGroupsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [contactGroupsApi.execute]);

  // Debounced preview. Triggers on rules changing — when the user mutates,
  // the in-memory rule list updates and that re-fires this effect after the
  // debounce window.
  useEffect(() => {
    if (!Number.isInteger(segmentId) || segmentId <= 0) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await previewApi.execute(
        `/api/segments/${segmentId}/rules/preview`,
        { method: "POST" },
      );
      if (cancelled) return;
      if (r.ok) {
        setPreview(r.data);
        setPreviewError(null);
        onRuleFilteredCountChanged?.(r.data.rule_filtered_count);
      } else {
        setPreviewError(r.error);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // rules.length and a hash-ish of rule signatures drive the debounce
    // (full `rules` would refire too often when typing in number fields).
  }, [segmentId, rulesTick, previewApi.execute, onRuleFilteredCountChanged]);

  async function handleAddRule() {
    // Pick a reasonable default: first rule type (engagement, no value).
    const defaultType: RuleType = "is_clicker_any_brand";
    const defaultOperator: "is" | "is_not" = "is";
    const body = {
      rule_type: defaultType,
      operator: defaultOperator,
      value: null,
      is_active: true,
      combinator: "and" as const,
    };
    const r = await createApi.execute(`/api/segments/${segmentId}/rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't add rule");
      return;
    }
    toast.success("Rule added");
    refetchRules();
  }

  async function handleDelete(ruleId: number) {
    const r = await fetch(`/api/segments/${segmentId}/rules/${ruleId}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      let msg = "Couldn't delete rule";
      try {
        const body = (await r.json()) as { error?: string };
        if (body?.error) msg = body.error;
      } catch {}
      toast.error(msg);
      return;
    }
    toast.success("Rule deleted");
    refetchRules();
  }

  async function handleReorder(fromIdx: number, toIdx: number) {
    if (
      fromIdx === toIdx ||
      toIdx < 0 ||
      toIdx >= rules.length ||
      fromIdx < 0 ||
      fromIdx >= rules.length
    )
      return;
    // Optimistic move so the UI feels snappy; revert on error.
    const reordered = [...rules];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    const prior = rules;
    setRules(reordered);
    const r = await fetch(`/api/segments/${segmentId}/rules/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rule_ids: reordered.map((x) => x.id) }),
    });
    if (!r.ok) {
      setRules(prior);
      let msg = "Couldn't reorder";
      try {
        const body = (await r.json()) as { error?: string };
        if (body?.error) msg = body.error;
      } catch {}
      toast.error(msg);
      return;
    }
    refetchRules();
  }

  const handleRuleSaved = useCallback(
    (updated: SegmentRule) => {
      setRules((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      // Trigger a preview refresh.
      setRulesTick((n) => n + 1);
    },
    [],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Audience Rules</h2>
          <p className="text-sm text-muted-foreground">
            Filter who counts as a member of this segment. Rules apply on top
            of manual membership.
          </p>
        </div>
        {canEdit ? (
          <Button
            size="sm"
            onClick={handleAddRule}
            disabled={createApi.isLoading}
          >
            <Plus className="size-4" aria-hidden /> Add rule
          </Button>
        ) : null}
      </div>

      {rulesError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">{rulesError}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={refetchRules}
          >
            Retry
          </Button>
        </div>
      ) : listApi.isLoading && rules.length === 0 ? (
        <div className="rounded-md border border-dashed py-12 text-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : rules.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed py-12 text-center">
          <p className="text-sm font-medium">No rules yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            All {manualCount.toLocaleString()} contacts in this segment qualify.
            Add a rule to narrow this down.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map((rule, idx) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              segmentId={segmentId}
              canEdit={canEdit}
              isFirst={idx === 0}
              brands={brands}
              offers={offers}
              segments={segmentsList}
              contactGroups={contactGroupOptions}
              brandsLoaded={brandsLoaded}
              offersLoaded={offersLoaded}
              segmentsLoaded={segmentsLoaded}
              contactGroupsLoaded={contactGroupsLoaded}
              onSaved={handleRuleSaved}
              onDelete={() => handleDelete(rule.id)}
              onMoveUp={
                idx > 0 ? () => handleReorder(idx, idx - 1) : undefined
              }
              onMoveDown={
                idx < rules.length - 1
                  ? () => handleReorder(idx, idx + 1)
                  : undefined
              }
            />
          ))}
        </div>
      )}

      <PreviewPanel
        preview={preview}
        previewError={previewError}
        isLoading={previewApi.isLoading}
        manualCount={manualCount}
        hasRules={rules.length > 0}
      />
    </div>
  );
}

interface RuleRowProps {
  rule: SegmentRule;
  segmentId: number;
  canEdit: boolean;
  // True for the topmost rule. Its combinator is ignored at eval time,
  // so we hide the AND/OR toggle for it.
  isFirst: boolean;
  brands: PickerOption[];
  offers: PickerOption[];
  segments: PickerOption[];
  contactGroups: PickerOption[];
  brandsLoaded: boolean;
  offersLoaded: boolean;
  segmentsLoaded: boolean;
  contactGroupsLoaded: boolean;
  onSaved: (rule: SegmentRule) => void;
  onDelete: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

function RuleRow({
  rule,
  segmentId,
  canEdit,
  isFirst,
  brands,
  offers,
  segments,
  contactGroups,
  brandsLoaded,
  offersLoaded,
  segmentsLoaded,
  contactGroupsLoaded,
  onSaved,
  onDelete,
  onMoveUp,
  onMoveDown,
}: RuleRowProps) {
  // Local edit state — we only PATCH when the user blurs or toggles a
  // control. While the user is editing, the row's in-flight state lives
  // here and we don't refire the preview yet.
  const [ruleType, setRuleType] = useState<RuleType>(rule.rule_type);
  const [operator, setOperator] = useState<"is" | "is_not">(rule.operator);
  const [value, setValue] = useState<unknown>(rule.value);
  const [isActive, setIsActive] = useState<boolean>(rule.is_active);
  const [combinator, setCombinator] = useState<"and" | "or">(rule.combinator);
  const [saving, setSaving] = useState(false);

  // Note: there is no `useEffect` to re-sync local state from `rule`. The
  // parent keys this row by `rule.id`, so a different rule unmounts and
  // remounts cleanly. For same-id updates (after our own save), local state
  // already matches what we just PATCHed.

  const shape = valueShapeFor(ruleType);
  const allowedOperators = RULE_TYPES[ruleType].operators;

  // Save a patch to the server. Caller passes the merged next state so we
  // don't race with state setters.
  const savePatch = useCallback(
    async (patch: Partial<{
      rule_type: RuleType;
      operator: "is" | "is_not";
      value: unknown;
      is_active: boolean;
      combinator: "and" | "or";
    }>) => {
      const merged = {
        rule_type: patch.rule_type ?? ruleType,
        operator: patch.operator ?? operator,
        value: patch.value !== undefined ? patch.value : value,
        is_active: patch.is_active ?? isActive,
      };
      if (
        !isRuleReadyToSave(merged.rule_type, merged.operator, merged.value)
      ) {
        // Local-only state — don't hit the server with an invalid combo.
        return;
      }
      setSaving(true);
      try {
        const r = await fetch(
          `/api/segments/${segmentId}/rules/${rule.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          },
        );
        if (!r.ok) {
          let msg = "Couldn't save rule";
          try {
            const body = (await r.json()) as { error?: string };
            if (body?.error) msg = body.error;
          } catch {}
          toast.error(msg);
          return;
        }
        const updated = (await r.json()) as SegmentRule;
        onSaved(updated);
      } finally {
        setSaving(false);
      }
    },
    [ruleType, operator, value, isActive, segmentId, rule.id, onSaved],
  );

  function handleCombinatorChange(next: "and" | "or") {
    setCombinator(next);
    void savePatch({ combinator: next });
  }

  function handleRuleTypeChange(next: RuleType) {
    setRuleType(next);
    const newShape = valueShapeFor(next);
    // Snap operator if the new rule type doesn't allow the current one.
    let newOperator = operator;
    if (!isValidOperatorForRuleType(next, operator)) {
      newOperator = RULE_TYPES[next].operators[0];
      setOperator(newOperator);
    }
    const newValue = coerceValueForShape(newShape, value);
    setValue(newValue);
    void savePatch({
      rule_type: next,
      operator: newOperator,
      value: newValue,
    });
  }

  function handleOperatorChange(next: "is" | "is_not") {
    setOperator(next);
    void savePatch({ operator: next });
  }

  function handleActiveChange(next: boolean) {
    setIsActive(next);
    void savePatch({ is_active: next });
  }

  // For numeric/FK inputs we save on blur, not on every keystroke. The
  // local Input value is already updated via state; this just commits it.
  function handleValueBlur() {
    if (value === rule.value) return;
    void savePatch({ value });
  }

  // Set editors (phone_type / carrier). Commit on every toggle, sending
  // rule_type + operator alongside the value — a switch TO a set type can't
  // persist on its own (an empty set is invalid), so we carry the pending
  // type/operator with the first non-empty selection. An empty set stays
  // local (server rejects it) and leaves the row marked incomplete.
  function handleSetChange(next: string[]) {
    setValue(next);
    if (next.length > 0) {
      void savePatch({ rule_type: ruleType, operator, value: next });
    }
  }

  // Rule is "incomplete" (persisted but doesn't yet have a valid FK value).
  // The eval skips incomplete rules; mark the row so the user sees they
  // need to pick a value before it affects audience.
  const incomplete = isRuleIncomplete(ruleType, value);

  return (
    <div className="space-y-2">
      {/* Combinator: how this rule joins to the running result of the
          prior rules. Hidden for the first rule (no prior context). */}
      {!isFirst ? (
        <div className="flex items-center gap-2 pl-7 text-xs uppercase tracking-wide text-muted-foreground">
          <Select
            value={combinator}
            onValueChange={(v) =>
              handleCombinatorChange(v as "and" | "or")
            }
            disabled={!canEdit || saving}
          >
            <SelectTrigger className="h-7 w-[78px] font-semibold text-foreground">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="and">AND</SelectItem>
              <SelectItem value="or">OR</SelectItem>
            </SelectContent>
          </Select>
          <span>with above</span>
        </div>
      ) : null}
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 rounded-md border bg-background p-3",
          !isActive && "opacity-60",
          incomplete && "border-amber-300 dark:border-amber-700",
        )}
        title={
          incomplete
            ? "Pick a value to activate this rule. Incomplete rules don't affect the audience."
            : undefined
        }
      >
      {/* Reorder controls */}
      <div className="flex flex-col">
        <button
          type="button"
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
          onClick={onMoveUp}
          disabled={!onMoveUp || !canEdit}
          aria-label="Move rule up"
        >
          <ChevronUp className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
          onClick={onMoveDown}
          disabled={!onMoveDown || !canEdit}
          aria-label="Move rule down"
        >
          <ChevronDown className="size-3.5" aria-hidden />
        </button>
      </div>

      {/* Rule type */}
      <Select
        value={ruleType}
        onValueChange={(v) => handleRuleTypeChange(v as RuleType)}
        disabled={!canEdit || saving}
      >
        <SelectTrigger className="h-9 w-[280px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RULE_TYPE_KEYS.map((k) => (
            <SelectItem key={k} value={k}>
              {RULE_TYPES[k].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Operator (only when more than one is allowed) */}
      {allowedOperators.length > 1 ? (
        <Select
          value={operator}
          onValueChange={(v) => handleOperatorChange(v as "is" | "is_not")}
          disabled={!canEdit || saving}
        >
          <SelectTrigger className="h-9 w-[88px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {allowedOperators.map((op) => (
              <SelectItem key={op} value={op}>
                {op === "is" ? "is" : "is not"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className="text-sm text-muted-foreground">is</span>
      )}

      {/* Value */}
      <ValueControl
        shape={shape}
        value={value}
        onChange={setValue}
        onBlur={handleValueBlur}
        onValueCommit={(next) => void savePatch({ value: next })}
        onSetChange={handleSetChange}
        disabled={!canEdit || saving}
        brands={brands}
        offers={offers}
        segments={segments}
        contactGroups={contactGroups}
        brandsLoaded={brandsLoaded}
        offersLoaded={offersLoaded}
        segmentsLoaded={segmentsLoaded}
        contactGroupsLoaded={contactGroupsLoaded}
        // For the fallback display when options haven't loaded yet (or the
        // referenced entity is no longer in the active list): use the
        // hydrated metadata from the rules list endpoint.
        currentRef={rule.ref}
      />

      <div className="ml-auto flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            size="sm"
            checked={isActive}
            onCheckedChange={handleActiveChange}
            disabled={!canEdit || saving}
          />
          Active
        </label>
        {saving ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
        ) : null}
        {canEdit ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            aria-label="Delete rule"
          >
            <Trash2 className="size-4" aria-hidden />
          </Button>
        ) : null}
      </div>
      </div>
    </div>
  );
}

interface ValueControlProps {
  shape: ValueShape | null;
  value: unknown;
  onChange: (next: unknown) => void;
  // Fired after the user commits a value via blur (number input) or
  // selection (FK select). The handler receives the explicit new value
  // so callers don't read stale state from a closure.
  onBlur: () => void;
  onValueCommit: (next: number | string) => void;
  // Commit handler for the set editors (phone_type / carrier). Receives the
  // full next array.
  onSetChange: (next: string[]) => void;
  disabled: boolean;
  brands: PickerOption[];
  offers: PickerOption[];
  segments: PickerOption[];
  contactGroups: PickerOption[];
  brandsLoaded: boolean;
  offersLoaded: boolean;
  segmentsLoaded: boolean;
  contactGroupsLoaded: boolean;
  currentRef: RefInfo;
}

function ValueControl({
  shape,
  value,
  onChange,
  onBlur,
  onValueCommit,
  onSetChange,
  disabled,
  brands,
  offers,
  segments,
  contactGroups,
  brandsLoaded,
  offersLoaded,
  segmentsLoaded,
  contactGroupsLoaded,
  currentRef,
}: ValueControlProps) {
  if (shape === "none") return null;
  if (shape === "phone_type_set" || shape === "carrier_set") {
    const arr = Array.isArray(value) ? (value as string[]) : [];
    const options =
      shape === "phone_type_set"
        ? PHONE_TYPE_VALUES
        : CARRIER_VALUES;
    return (
      <SetPills
        options={options}
        labels={shape === "phone_type_set" ? PHONE_TYPE_LABELS : undefined}
        value={arr}
        disabled={disabled}
        onChange={onSetChange}
      />
    );
  }
  if (shape === "positive_integer") {
    const n = typeof value === "number" ? value : "";
    return (
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          min={1}
          max={36500}
          step={1}
          value={n}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              onChange(null);
              return;
            }
            const parsed = Number.parseInt(raw, 10);
            if (Number.isInteger(parsed) && parsed >= 1) {
              onChange(parsed);
            }
          }}
          onBlur={onBlur}
          disabled={disabled}
          className="h-9 w-20"
        />
        <span className="text-xs text-muted-foreground">days</span>
      </div>
    );
  }
  if (shape === "campaign_use_period") {
    const current = isCampaignUsePeriod(value) ? value : undefined;
    return (
      <Select
        value={current ?? ""}
        onValueChange={(v) => {
          onChange(v);
          onValueCommit(v);
        }}
        disabled={disabled}
      >
        <SelectTrigger className="h-9 w-[140px]">
          <SelectValue placeholder="Select a period" />
        </SelectTrigger>
        <SelectContent>
          {CAMPAIGN_USE_PERIODS.map((p) => (
            <SelectItem key={p.code} value={p.code}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  const options =
    shape === "brand_id"
      ? brands
      : shape === "offer_id"
        ? offers
        : shape === "segment_id"
          ? segments
          : shape === "contact_group_id"
            ? contactGroups
            : [];
  const loaded =
    shape === "brand_id"
      ? brandsLoaded
      : shape === "offer_id"
        ? offersLoaded
        : shape === "segment_id"
          ? segmentsLoaded
          : shape === "contact_group_id"
            ? contactGroupsLoaded
            : true;
  const featureMissing =
    (shape === "brand_id" && !isEntityAvailable("brands")) ||
    (shape === "offer_id" && !isEntityAvailable("offers")) ||
    (shape === "contact_group_id" && !isEntityAvailable("contact_groups"));
  if (featureMissing) {
    return (
      <span className="text-xs text-muted-foreground">
        {shape === "brand_id"
          ? "Brands"
          : shape === "offer_id"
            ? "Offers"
            : "Contact groups"}{" "}
        not yet enabled
      </span>
    );
  }

  // Placeholder shown when the user has no current selection. Three cases:
  // (1) fetch still pending → "Loading…"; (2) loaded with zero options →
  // a helpful message pointing at the registry page; (3) loaded with
  // options → the normal "Select X" placeholder.
  const placeholder = !loaded
    ? "Loading…"
    : options.length === 0
      ? shape === "brand_id"
        ? "No brands available — create one in /brands first"
        : shape === "offer_id"
          ? "No offers available — create one in /offers first"
          : shape === "segment_id"
            ? "No other segments available"
            : "No contact groups — create one in /contact-groups first"
      : shape === "brand_id"
        ? "Select a brand"
        : shape === "offer_id"
          ? "Select an offer"
          : shape === "segment_id"
            ? "Select a segment"
            : "Select a contact group";

  // Fallback display: when the rule has a persisted value but the picker
  // hasn't loaded its options yet (or the referenced entity is no longer
  // in the active list), show the hydrated `ref.name` so the user can see
  // what's currently selected. Opening the dropdown still works once
  // options arrive.
  const hasValue = typeof value === "number";
  const matchedInOptions =
    hasValue && options.some((o) => o.id === (value as number));
  const showFallback = hasValue && !matchedInOptions && currentRef !== null;

  return (
    <Select
      value={hasValue ? String(value) : ""}
      onValueChange={(v) => {
        const parsed = Number.parseInt(v, 10);
        if (!Number.isFinite(parsed)) return;
        onChange(parsed);
        // Save explicitly with the new value — previously we relied on a
        // queueMicrotask(onBlur) dance that read `value` from the render's
        // closure, which is the PRE-pick value because setValue is async.
        // That caused the saved value to lag one selection behind the user's
        // actual pick. Pass the new value to onValueCommit so the save uses
        // the user's actual choice.
        onValueCommit(parsed);
      }}
      disabled={disabled}
    >
      <SelectTrigger className="h-9 w-[200px]">
        {/*
          Children must be conditionally omitted (not passed as `null`) —
          Radix Select.Value renders whatever you pass as children, so
          `children={null}` produces a blank trigger. Falling through to
          the unguarded SelectValue lets Radix render the selected
          option's content via its internal ItemText mirroring.
        */}
        {showFallback ? (
          <SelectValue placeholder={placeholder}>
            <span className="inline-flex items-center gap-2">
              {currentRef!.color ? (
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: currentRef!.color }}
                />
              ) : null}
              <span className="truncate">{currentRef!.name}</span>
            </span>
          </SelectValue>
        ) : (
          <SelectValue placeholder={placeholder} />
        )}
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.id} value={String(o.id)}>
            <span className="inline-flex items-center gap-2">
              {o.color ? (
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: o.color }}
                />
              ) : null}
              {o.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Small pill/checkbox group for the phone_type / carrier set editors (≤7
// options). Toggling commits immediately via onChange.
function SetPills({
  options,
  labels,
  value,
  disabled,
  onChange,
}: {
  options: readonly string[];
  labels?: Record<string, string>;
  value: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const selected = new Set(value);
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => {
        const active = selected.has(opt);
        return (
          <button
            key={opt}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() =>
              onChange(
                active ? value.filter((v) => v !== opt) : [...value, opt],
              )
            }
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
              active
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-background text-muted-foreground hover:bg-muted",
              disabled && "cursor-not-allowed opacity-60",
            )}
          >
            {labels?.[opt] ?? opt}
          </button>
        );
      })}
    </div>
  );
}

interface PreviewPanelProps {
  preview: PreviewResponse | null;
  previewError: string | null;
  isLoading: boolean;
  manualCount: number;
  hasRules: boolean;
}

function PreviewPanel({
  preview,
  previewError,
  isLoading,
  manualCount,
  hasRules,
}: PreviewPanelProps) {
  return (
    <div className="rounded-md border bg-muted/40 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Preview</span>
        {isLoading ? (
          <Loader2
            className="size-3.5 animate-spin text-muted-foreground"
            aria-hidden
          />
        ) : null}
        {!hasRules ? (
          <Badge variant="secondary" className="text-xs">
            no rules
          </Badge>
        ) : preview?.truncated ? (
          <Badge className="border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            timed out
          </Badge>
        ) : null}
      </div>
      {previewError ? (
        <p className="mt-2 text-destructive">{previewError}</p>
      ) : !hasRules ? (
        <p className="mt-1 text-muted-foreground">
          All {manualCount.toLocaleString()} contacts qualify.
        </p>
      ) : preview?.truncated ? (
        <p className="mt-1 text-muted-foreground">
          Preview took longer than 10s. Refine rules or refresh stats from the
          header to compute in the background.
        </p>
      ) : preview ? (
        // Under UNION semantics the count is the FULL audience (manual ∪
        // rule_matches), which can be larger than manual. We surface both
        // numbers separately so the user sees how much the rules expanded
        // (or didn't expand) the manual set.
        <p className="mt-1 tabular-nums">
          <span className="text-base font-semibold">
            {(preview.count ?? 0).toLocaleString()}
          </span>{" "}
          <span className="text-muted-foreground">
            contact{preview.count === 1 ? "" : "s"} in audience ·{" "}
            {preview.manual_count.toLocaleString()} manual member
            {preview.manual_count === 1 ? "" : "s"} ({preview.duration_ms} ms)
          </span>
        </p>
      ) : (
        <p className="mt-1 text-muted-foreground">Computing…</p>
      )}
    </div>
  );
}
