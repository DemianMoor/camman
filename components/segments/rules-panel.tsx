"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  getValueShapeForRuleType,
  isValidOperatorForRuleType,
  RULE_TYPES,
  RULE_TYPE_KEYS,
  type RuleType,
  type ValueShape,
} from "@/lib/validators/segment-rule-types";

type RefInfo = { id: number; name: string; color: string | null } | null;

export type SegmentRule = {
  id: number;
  segment_id: number;
  rule_type: RuleType;
  operator: "is" | "is_not";
  value: unknown;
  position: number;
  is_active: boolean;
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
  if (shape === "brand_id" || shape === "offer_id" || shape === "segment_id") {
    return typeof prior === "number" ? prior : null;
  }
  return null;
}

// Whether the rule is fully specified enough to PATCH to the server. The
// server re-validates, but we don't hit it with obvious nonsense.
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
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
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

  // FK picker option fetches, gated on feature flags.
  const brandsApi = useApiCall<{ data: PickerOption[] }>();
  const offersApi = useApiCall<{ data: PickerOption[] }>();
  const segmentsApi = useApiCall<{ data: PickerOption[] }>();
  const [brands, setBrands] = useState<PickerOption[]>([]);
  const [offers, setOffers] = useState<PickerOption[]>([]);
  const [segmentsList, setSegmentsList] = useState<PickerOption[]>([]);

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

  // Lazy-load FK pickers. Only fetch when a rule of that shape exists or is
  // being added — otherwise this is wasted bandwidth on segments with rules
  // that don't reference these entities.
  const needBrands = useMemo(
    () => rules.some((r) => valueShapeFor(r.rule_type) === "brand_id"),
    [rules],
  );
  const needOffers = useMemo(
    () => rules.some((r) => valueShapeFor(r.rule_type) === "offer_id"),
    [rules],
  );
  const needSegments = useMemo(
    () => rules.some((r) => valueShapeFor(r.rule_type) === "segment_id"),
    [rules],
  );

  useEffect(() => {
    if (!needBrands || !isEntityAvailable("brands")) return;
    let cancelled = false;
    (async () => {
      const r = await brandsApi.execute("/api/brands/list?pageSize=500");
      if (cancelled) return;
      if (r.ok) setBrands(r.data.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [needBrands, brandsApi.execute]);

  useEffect(() => {
    if (!needOffers || !isEntityAvailable("offers")) return;
    let cancelled = false;
    (async () => {
      const r = await offersApi.execute("/api/offers/list?pageSize=500");
      if (cancelled) return;
      if (r.ok) setOffers(r.data.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [needOffers, offersApi.execute]);

  useEffect(() => {
    if (!needSegments) return;
    let cancelled = false;
    (async () => {
      const r = await segmentsApi.execute("/api/segments/list?pageSize=500");
      if (cancelled) return;
      // Exclude the current segment to prevent obvious self-reference loops.
      if (r.ok) {
        setSegmentsList(
          r.data.data.filter((s) => s.id !== currentSegmentDbId),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needSegments, currentSegmentDbId, segmentsApi.execute]);

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
              brands={brands}
              offers={offers}
              segments={segmentsList}
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
  brands: PickerOption[];
  offers: PickerOption[];
  segments: PickerOption[];
  onSaved: (rule: SegmentRule) => void;
  onDelete: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

function RuleRow({
  rule,
  segmentId,
  canEdit,
  brands,
  offers,
  segments,
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

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md border bg-background p-3",
        !isActive && "opacity-60",
      )}
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
        disabled={!canEdit || saving}
        brands={brands}
        offers={offers}
        segments={segments}
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
  );
}

interface ValueControlProps {
  shape: ValueShape | null;
  value: unknown;
  onChange: (next: unknown) => void;
  onBlur: () => void;
  disabled: boolean;
  brands: PickerOption[];
  offers: PickerOption[];
  segments: PickerOption[];
}

function ValueControl({
  shape,
  value,
  onChange,
  onBlur,
  disabled,
  brands,
  offers,
  segments,
}: ValueControlProps) {
  if (shape === "none") return null;
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
  const options =
    shape === "brand_id"
      ? brands
      : shape === "offer_id"
        ? offers
        : shape === "segment_id"
          ? segments
          : [];
  const placeholder =
    shape === "brand_id"
      ? "Select brand"
      : shape === "offer_id"
        ? "Select offer"
        : "Select segment";
  const featureMissing =
    (shape === "brand_id" && !isEntityAvailable("brands")) ||
    (shape === "offer_id" && !isEntityAvailable("offers"));
  if (featureMissing) {
    return (
      <span className="text-xs text-muted-foreground">
        {shape === "brand_id" ? "Brands" : "Offers"} not yet enabled
      </span>
    );
  }
  return (
    <Select
      value={typeof value === "number" ? String(value) : ""}
      onValueChange={(v) => {
        const parsed = Number.parseInt(v, 10);
        onChange(parsed);
        // FK selects don't blur; commit immediately via onBlur callback so
        // the parent saves the patch.
        queueMicrotask(onBlur);
      }}
      disabled={disabled || options.length === 0}
    >
      <SelectTrigger className="h-9 w-[200px]">
        <SelectValue
          placeholder={options.length === 0 ? "Loading…" : placeholder}
        />
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
        <p className="mt-1 tabular-nums">
          <span className="text-base font-semibold">
            {(preview.count ?? 0).toLocaleString()}
          </span>{" "}
          <span className="text-muted-foreground">
            of {preview.manual_count.toLocaleString()} manual members match (
            {preview.duration_ms} ms)
          </span>
        </p>
      ) : (
        <p className="mt-1 text-muted-foreground">Computing…</p>
      )}
    </div>
  );
}
