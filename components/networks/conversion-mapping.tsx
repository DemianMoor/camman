"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Pencil, Plus, Power } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import {
  CONVERSION_STATUSES,
  KEITARO_CONVERSION_TYPES,
  type ConversionMappingStatus,
  type KeitaroConversionType,
} from "@/lib/validators/conversion-mappings";

// Network-level conversion mapping rules: Keitaro conversion type → CamMan
// event type + status. Used by the create form (pre-filled defaults) and the
// "Conversion mapping" dialog on the Affiliate Networks page.

export type EventTypeOption = { id: number; key: string; label: string };

export const STATUS_LABELS: Record<ConversionMappingStatus, string> = {
  approved: "Approved",
  pending: "Pending",
  rejected: "Rejected",
};

export const NO_RULES_COPY =
  "Every conversion from this network lands unmapped and counts as nothing in sales and revenue until a rule is added.";

/** Keitaro type (fixed or selectable) → event type → status. */
export function RuleSelects({
  keitaroType,
  onKeitaroTypeChange,
  availableKeitaroTypes,
  eventTypeId,
  onEventTypeChange,
  status,
  onStatusChange,
  eventTypes,
  disabled,
}: {
  keitaroType: KeitaroConversionType | undefined;
  /** Omit to show the Keitaro type as fixed text. */
  onKeitaroTypeChange?: (t: KeitaroConversionType) => void;
  availableKeitaroTypes?: readonly KeitaroConversionType[];
  eventTypeId: number | undefined;
  onEventTypeChange: (id: number) => void;
  status: ConversionMappingStatus | undefined;
  onStatusChange: (s: ConversionMappingStatus) => void;
  eventTypes: EventTypeOption[];
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
      {onKeitaroTypeChange ? (
        <Select
          value={keitaroType ?? ""}
          onValueChange={(v) => onKeitaroTypeChange(v as KeitaroConversionType)}
          disabled={disabled}
        >
          <SelectTrigger size="sm" className="w-full" aria-label="Keitaro type">
            <SelectValue placeholder="Keitaro type" />
          </SelectTrigger>
          <SelectContent>
            {(availableKeitaroTypes ?? KEITARO_CONVERSION_TYPES).map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className="truncate font-mono text-sm">{keitaroType}</span>
      )}
      <span className="text-muted-foreground" aria-hidden>
        →
      </span>
      <Select
        value={eventTypeId !== undefined ? String(eventTypeId) : ""}
        onValueChange={(v) => onEventTypeChange(Number(v))}
        disabled={disabled}
      >
        <SelectTrigger size="sm" className="w-full" aria-label="Event type">
          <SelectValue placeholder="Event type" />
        </SelectTrigger>
        <SelectContent>
          {eventTypes.map((et) => (
            <SelectItem key={et.id} value={String(et.id)}>
              {et.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={status ?? ""}
        onValueChange={(v) => onStatusChange(v as ConversionMappingStatus)}
        disabled={disabled}
      >
        <SelectTrigger size="sm" className="w-full" aria-label="Status">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          {CONVERSION_STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {STATUS_LABELS[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

type Rule = {
  id: number;
  keitaro_type: string;
  event_type_id: number | null;
  event_type_label: string | null;
  conversion_status: ConversionMappingStatus;
};

type Draft = {
  keitaro_type?: KeitaroConversionType;
  event_type_id?: number;
  conversion_status?: ConversionMappingStatus;
};

type Confirming =
  | { kind: "edit"; rule: Rule; draft: Draft }
  | { kind: "deactivate"; rule: Rule }
  | null;

export function ConversionMappingDialog({
  network,
  onOpenChange,
  canEdit,
  eventTypes,
  onChanged,
}: {
  network: { id: number; name: string } | null;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
  eventTypes: EventTypeOption[] | null;
  /** Called after any successful write, so the list's rule count refreshes. */
  onChanged: () => void;
}) {
  return (
    <FormDialog
      open={network !== null}
      onOpenChange={onOpenChange}
      className="sm:max-w-2xl"
    >
      <DialogHeader>
        <DialogTitle>Conversion mapping</DialogTitle>
        <DialogDescription>
          {network ? `${network.name} — ` : ""}how each Keitaro conversion type
          from this network is counted. Changes apply on the next Keitaro poll
          (within ~5 min) to conversions from the last 7 days.
        </DialogDescription>
      </DialogHeader>
      {network ? (
        <MappingRulesBody
          key={network.id}
          networkId={network.id}
          canEdit={canEdit}
          eventTypes={eventTypes ?? []}
          onChanged={onChanged}
        />
      ) : null}
    </FormDialog>
  );
}

function MappingRulesBody({
  networkId,
  canEdit,
  eventTypes,
  onChanged,
}: {
  networkId: number;
  canEdit: boolean;
  eventTypes: EventTypeOption[];
  onChanged: () => void;
}) {
  const { execute: fetchRules } = useApiCall<{ data: Rule[] }>();
  const writeApi = useApiCall<unknown>();

  const [rules, setRules] = useState<Rule[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; draft: Draft } | null>(null);
  const [adding, setAdding] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);

  // Bumped after every write (and by Retry) to re-read the rules.
  const [reloadTick, setReloadTick] = useState(0);
  const reload = () => setReloadTick((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await fetchRules(`/api/networks/${networkId}/mappings`);
      if (cancelled) return;
      if (result.ok) {
        setRules(result.data.data);
        setLoadError(null);
      } else {
        setLoadError(result.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchRules, networkId, reloadTick]);

  async function write(url: string, init: RequestInit, success: string, failure: string) {
    const result = await writeApi.execute(url, init);
    if (!result.ok) {
      toastApiError(result, failure);
      return false;
    }
    toast.success(success);
    onChanged();
    reload();
    return true;
  }

  async function handleConfirm() {
    if (!confirming) return;
    const base = `/api/networks/${networkId}/mappings/${confirming.rule.id}`;
    const ok =
      confirming.kind === "edit"
        ? await write(
            base,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                event_type_id: confirming.draft.event_type_id,
                conversion_status: confirming.draft.conversion_status,
              }),
            },
            "Rule saved",
            "Couldn't save rule",
          )
        : await write(
            `${base}/archive`,
            { method: "POST" },
            "Rule deactivated",
            "Couldn't deactivate rule",
          );
    if (ok) {
      setConfirming(null);
      setEditing(null);
    }
  }

  async function handleAdd() {
    if (!adding) return;
    if (!adding.keitaro_type || !adding.event_type_id || !adding.conversion_status) {
      toast.error("Pick a Keitaro type, event type and status");
      return;
    }
    const ok = await write(
      `/api/networks/${networkId}/mappings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(adding),
      },
      "Rule added",
      "Couldn't add rule",
    );
    if (ok) setAdding(null);
  }

  function startSave(rule: Rule, draft: Draft) {
    const changed =
      draft.event_type_id !== (rule.event_type_id ?? undefined) ||
      draft.conversion_status !== rule.conversion_status;
    if (!changed) {
      setEditing(null);
      return;
    }
    setConfirming({ kind: "edit", rule, draft });
  }

  if (loadError) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
        <p className="text-destructive">Couldn&apos;t load rules: {loadError}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={reload}>
          Retry
        </Button>
      </div>
    );
  }
  if (rules === null) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
      </div>
    );
  }

  const usedTypes = new Set(rules.map((r) => r.keitaro_type));
  const freeTypes = KEITARO_CONVERSION_TYPES.filter((t) => !usedTypes.has(t));
  const busy = writeApi.isLoading;

  return (
    <div className="space-y-4">
      {rules.length === 0 ? (
        <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            <span className="font-medium">No conversion rules.</span> {NO_RULES_COPY}
          </p>
        </div>
      ) : (
        <ul className="divide-y rounded-md border">
          {rules.map((rule) => {
            const isEditing = editing?.id === rule.id;
            return (
              <li key={rule.id} className="flex items-center gap-2 p-2">
                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <RuleSelects
                      keitaroType={rule.keitaro_type as KeitaroConversionType}
                      eventTypeId={editing.draft.event_type_id}
                      onEventTypeChange={(id) =>
                        setEditing({ id: rule.id, draft: { ...editing.draft, event_type_id: id } })
                      }
                      status={editing.draft.conversion_status}
                      onStatusChange={(s) =>
                        setEditing({ id: rule.id, draft: { ...editing.draft, conversion_status: s } })
                      }
                      eventTypes={eventTypes}
                      disabled={busy}
                    />
                  ) : (
                    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 text-sm">
                      <span className="truncate font-mono">{rule.keitaro_type}</span>
                      <span className="text-muted-foreground" aria-hidden>
                        →
                      </span>
                      <span className="truncate">
                        {rule.event_type_label ?? (
                          <span className="text-muted-foreground">(keeps existing type)</span>
                        )}
                      </span>
                      <span className="truncate">{STATUS_LABELS[rule.conversion_status]}</span>
                    </div>
                  )}
                </div>
                {canEdit ? (
                  isEditing ? (
                    <div className="flex shrink-0 gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={busy}>
                        Cancel
                      </Button>
                      <Button size="sm" onClick={() => startSave(rule, editing.draft)} disabled={busy}>
                        Save
                      </Button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Edit ${rule.keitaro_type} rule`}
                        disabled={busy || editing !== null}
                        onClick={() =>
                          setEditing({
                            id: rule.id,
                            draft: {
                              event_type_id: rule.event_type_id ?? undefined,
                              conversion_status: rule.conversion_status,
                            },
                          })
                        }
                      >
                        <Pencil className="size-4" aria-hidden />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Deactivate ${rule.keitaro_type} rule`}
                        disabled={busy || editing !== null}
                        onClick={() => setConfirming({ kind: "deactivate", rule })}
                      >
                        <Power className="size-4" aria-hidden />
                      </Button>
                    </div>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {canEdit ? (
        adding ? (
          <div className="flex items-center gap-2 rounded-md border border-dashed p-2">
            <div className="min-w-0 flex-1">
              <RuleSelects
                keitaroType={adding.keitaro_type}
                onKeitaroTypeChange={(t) => setAdding({ ...adding, keitaro_type: t })}
                availableKeitaroTypes={freeTypes}
                eventTypeId={adding.event_type_id}
                onEventTypeChange={(id) => setAdding({ ...adding, event_type_id: id })}
                status={adding.conversion_status}
                onStatusChange={(s) => setAdding({ ...adding, conversion_status: s })}
                eventTypes={eventTypes}
                disabled={busy}
              />
            </div>
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="ghost" onClick={() => setAdding(null)} disabled={busy}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void handleAdd()} disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                Add
              </Button>
            </div>
          </div>
        ) : freeTypes.length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAdding({})}
            disabled={busy || editing !== null}
          >
            <Plus className="size-4" aria-hidden /> Add rule
          </Button>
        ) : null
      ) : (
        <p className="text-xs text-muted-foreground">
          View only. A manager or above can change these rules.
        </p>
      )}

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.kind === "deactivate"
                ? `Deactivate the “${confirming.rule.keitaro_type}” rule?`
                : `Save the “${confirming?.rule.keitaro_type ?? ""}” rule?`}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                {confirming ? <ConfirmBody confirming={confirming} eventTypes={eventTypes} /> : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={confirming?.kind === "deactivate" ? "destructive" : "default"}
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void handleConfirm();
              }}
            >
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {confirming?.kind === "deactivate" ? "Deactivate" : "Save rule"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// The 7-day rewrite effect. Ingest re-reads Keitaro's last 7 days on every
// 5-minute poll: status takes the newest mapping, event type is locked once set
// (a different one is recorded as a conflict and pages Telegram), and a type
// with no rule turns unmapped. See docs/04-features/conversion-events.md.
function ConfirmBody({
  confirming,
  eventTypes,
}: {
  confirming: NonNullable<Confirming>;
  eventTypes: EventTypeOption[];
}) {
  const type = confirming.rule.keitaro_type;
  const intro = (
    <p>
      Keitaro conversions of type <span className="font-mono">{type}</span> from
      this network in the <span className="font-medium">last 7 days</span> are
      re-read on every poll. On the next poll (within ~5 minutes):
    </p>
  );
  const outro = (
    <p>
      Conversions older than 7 days don&apos;t change unless the conversion
      backfill script is run.
    </p>
  );

  if (confirming.kind === "deactivate") {
    return (
      <>
        {intro}
        <ul className="list-disc space-y-1 pl-5">
          <li>
            they become <span className="font-medium">unmapped</span> and drop
            out of sales, revenue and EPC for those days;
          </li>
          <li>new conversions of this type also land unmapped until a rule is added again.</li>
        </ul>
        {outro}
      </>
    );
  }

  const { rule, draft } = confirming;
  const statusChanged = draft.conversion_status !== rule.conversion_status;
  const typeChanged = draft.event_type_id !== (rule.event_type_id ?? undefined);
  const newLabel = eventTypes.find((e) => e.id === draft.event_type_id)?.label ?? "the new type";
  return (
    <>
      {intro}
      <ul className="list-disc space-y-1 pl-5">
        {statusChanged && draft.conversion_status ? (
          <li>
            their status becomes{" "}
            <span className="font-medium">{STATUS_LABELS[draft.conversion_status]}</span>,
            so sales, revenue and EPC for those days change;
          </li>
        ) : null}
        {typeChanged ? (
          <li>
            they <span className="font-medium">keep their current event type</span>{" "}
            (it is locked once set) and are flagged as event-type conflicts,
            which sends a Telegram alert. Only new conversions are counted as{" "}
            {newLabel}.
          </li>
        ) : null}
      </ul>
      {outro}
    </>
  );
}
