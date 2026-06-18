"use client";

import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { FileDropZone } from "@/components/file-drop-zone";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastApiError } from "@/lib/api/toast-error";
import type {
  CanonicalFieldKey,
  MappingColumns,
  StatusValueMap,
} from "@/lib/imports/canonical-fields";
import { useApiCall } from "@/lib/hooks/use-api-call";

// =============== Types ===============

type SavedMapping = {
  id: number;
  sms_provider_id: number;
  name: string;
  is_default: boolean;
  mapping: MappingColumns;
  status_value_map: StatusValueMap | null;
};

type PreviewResponse = {
  submitted: number;
  parsed: number;
  invalid_phone: number;
  // Post-priority-dedup unique-phone count. Equals the sum of by_outcome.
  unique_numbers: number;
  // CSV rows dropped because the same phone had a higher- or equal-
  // priority outcome from another row.
  events_collapsed: number;
  by_outcome: {
    delivered: number;
    failed: number;
    optout: number;
    clicker: number;
    scrubbed: number;
    bounced: number;
    noop: number;
  };
  sample_rows: Array<{
    outcome: string;
    phone_number: string;
    raw: Record<string, string>;
  }>;
  existing_in_db: number;
};

type ImportResponse = {
  id: number;
  submitted_rows: number;
  processed_rows: number;
  delivered_added: number;
  failed_added: number;
  optouts_added: number;
  clickers_added: number;
  scrubbed_added: number;
  bounced_added: number;
  total_cost_added: number;
  skipped_idempotent: number;
};

export interface ResultsImportFormProps {
  campaignId: number;
  stageId: number;
  stage: {
    stage_number: number;
    sms_provider_id: number | null;
    provider?: { id: number; name: string } | null;
  };
  onClose: () => void;
  onComplete: () => void; // called after successful import for refetch
}

const NONE = "__none__";

const CANONICAL_LABELS: Record<CanonicalFieldKey, string> = {
  phone_number: "Phone Number",
  status: "Status",
  is_optout: "Is Opt-Out",
  is_clicker: "Is Clicker",
  cost: "Cost",
};

// CanonicalFieldKey values that are required in the mapping step.
const REQUIRED_CANONICAL: ReadonlySet<CanonicalFieldKey> = new Set([
  "phone_number",
]);

const CANONICAL_ORDER: CanonicalFieldKey[] = [
  "phone_number",
  "status",
  "is_optout",
  "is_clicker",
  "cost",
];

// Canonical outcomes the Status column can map to, with example provider
// words shown as placeholders. Leaving a row blank falls back to built-in
// detection (which already treats Completed/Delivered/Opened as delivered
// and Filtered as failed).
type StatusMapKey = keyof StatusValueMap;
const STATUS_MAP_OUTCOMES: { key: StatusMapKey; label: string; eg: string }[] =
  [
    { key: "delivered", label: "Delivered", eg: "Completed, Delivered, Opened" },
    { key: "failed", label: "Failed", eg: "Filtered, Failed" },
    { key: "opt_out", label: "Opt-out", eg: "Stop, Unsubscribe" },
    { key: "clicker", label: "Clicker", eg: "Clicked" },
    { key: "scrubbed", label: "Scrubbed", eg: "Invalid, Landline" },
    { key: "bounced", label: "Bounced", eg: "Bounced" },
  ];

// The editor edits raw comma-separated strings (one per outcome) so typing
// stays smooth; the StatusValueMap is derived from them on submit/save.
function statusMapToRaw(m: StatusValueMap | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const { key } of STATUS_MAP_OUTCOMES) {
    const arr = m[key];
    if (arr && arr.length > 0) out[key] = arr.join(", ");
  }
  return out;
}

function rawToStatusMap(raw: Record<string, string>): StatusValueMap | null {
  const out: StatusValueMap = {};
  for (const { key } of STATUS_MAP_OUTCOMES) {
    const values = (raw[key] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (values.length > 0) out[key] = values;
  }
  return Object.keys(out).length > 0 ? out : null;
}

const MAX_BYTES = 25 * 1024 * 1024;

// =============== Component ===============

export function ResultsImportForm({
  campaignId,
  stageId,
  stage,
  onClose,
  onComplete,
}: ResultsImportFormProps) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  // Step 1: file
  const [file, setFile] = useState<File | null>(null);
  const [csvText, setCsvText] = useState<string>("");
  const [headerColumns, setHeaderColumns] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<Record<string, string>[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);

  // Step 2: mapping
  const mappingsApi = useApiCall<{ data: SavedMapping[] }>();
  const createMappingApi = useApiCall<SavedMapping>();
  const [savedMappings, setSavedMappings] = useState<SavedMapping[]>([]);
  const [selectedMappingId, setSelectedMappingId] = useState<number | null>(
    null,
  );
  const [mappingColumns, setMappingColumns] = useState<MappingColumns>({});
  // Raw comma-separated status words per outcome (editor buffer). Derived
  // into a StatusValueMap when previewing / importing / saving.
  const [statusRaw, setStatusRaw] = useState<Record<string, string>>({});
  const [saveAsMapping, setSaveAsMapping] = useState<boolean>(true);
  const [saveAsName, setSaveAsName] = useState<string>("");
  // Per-import, not part of the saved mapping. When non-empty (and a
  // valid number), the import endpoint uses this as the total cost
  // instead of summing the per-row `cost` column from the CSV.
  const [totalCostOverride, setTotalCostOverride] = useState<string>("");

  // Step 3: preview
  const previewApi = useApiCall<PreviewResponse>();
  const [preview, setPreview] = useState<PreviewResponse | null>(null);

  // Step 4: import
  const importApi = useApiCall<ImportResponse>();
  const [importResult, setImportResult] = useState<ImportResponse | null>(null);

  // Fetch saved mappings for this stage's provider on mount.
  useEffect(() => {
    if (!stage.sms_provider_id) return;
    (async () => {
      const r = await mappingsApi.execute(
        `/api/result-import-mappings/list?provider_id=${stage.sms_provider_id}`,
      );
      if (r.ok) {
        setSavedMappings(r.data.data);
        // Auto-pick default if present.
        const def = r.data.data.find((m) => m.is_default);
        if (def) {
          setSelectedMappingId(def.id);
          setMappingColumns(def.mapping);
          setStatusRaw(statusMapToRaw(def.status_value_map ?? null));
        }
      }
    })();
  }, [stage.sms_provider_id, mappingsApi.execute]);

  // Suggest a default save-as name.
  useEffect(() => {
    if (saveAsName === "" && stage.provider?.name) {
      setSaveAsName(`Default ${stage.provider.name}`);
    }
  }, [stage.provider?.name, saveAsName]);

  // ============ Step 1: handle file pick ============
  function handleFile(picked: File | null) {
    setFileError(null);
    setFile(picked);
    setCsvText("");
    setHeaderColumns([]);
    setPreviewRows([]);
    if (!picked) return;
    if (picked.size > MAX_BYTES) {
      setFileError("File exceeds 25MB limit.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      setCsvText(text);
      // Parse just the first ~5 rows for the preview table.
      const parsed = Papa.parse<Record<string, string>>(text, {
        header: true,
        skipEmptyLines: "greedy",
        preview: 5,
        transformHeader: (h) => h.trim(),
      });
      setHeaderColumns(parsed.meta.fields ?? []);
      setPreviewRows(parsed.data);
    };
    reader.onerror = () => {
      setFileError("Could not read file.");
    };
    reader.readAsText(picked);
  }

  // ============ Step 2: mapping helpers ============
  function setColumn(key: CanonicalFieldKey, value: string | undefined) {
    setMappingColumns((prev) => {
      const next = { ...prev };
      if (!value || value === NONE) delete next[key];
      else next[key] = value;
      return next;
    });
  }

  function onPickSavedMapping(idStr: string) {
    if (idStr === NONE) {
      setSelectedMappingId(null);
      setMappingColumns({});
      setStatusRaw({});
      return;
    }
    const id = Number(idStr);
    const m = savedMappings.find((x) => x.id === id);
    if (!m) return;
    setSelectedMappingId(id);
    setMappingColumns(m.mapping);
    setStatusRaw(statusMapToRaw(m.status_value_map ?? null));
  }

  const mappingValid = useMemo(() => {
    return !!mappingColumns.phone_number;
  }, [mappingColumns]);

  // ============ Step 3: run preview ============
  async function runPreview() {
    if (!mappingValid) {
      toast.error("Phone Number column is required.");
      return;
    }
    const r = await previewApi.execute(
      `/api/campaigns/${campaignId}/stages/${stageId}/import-preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csv_content: csvText,
          mapping: mappingColumns,
          status_value_map: rawToStatusMap(statusRaw) ?? undefined,
        }),
      },
    );
    if (r.ok) {
      setPreview(r.data);
      setStep(3);
    } else {
      toastApiError(r);
    }
  }

  // ============ Step 4: actual import ============
  async function runImport() {
    // Optionally save the mapping for future use. If selectedMappingId is
    // set, we don't re-save; we just reference it.
    let mappingIdToUse: number | null = selectedMappingId;
    if (
      mappingIdToUse === null &&
      saveAsMapping &&
      stage.sms_provider_id !== null
    ) {
      const r = await createMappingApi.execute(
        `/api/result-import-mappings`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sms_provider_id: stage.sms_provider_id,
            name: saveAsName.trim() || "Untitled mapping",
            is_default: savedMappings.length === 0, // first one becomes default
            mapping: mappingColumns,
            status_value_map: rawToStatusMap(statusRaw) ?? undefined,
          }),
        },
      );
      if (r.ok) {
        mappingIdToUse = r.data.id;
      } else {
        // Non-fatal — import can still proceed without saving the mapping.
        toastApiError(r);
      }
    }

    // Parse the optional total cost override. Empty string → omit;
    // unparseable → omit (the server validator would reject NaN anyway,
    // but omitting keeps the existing per-row sum path).
    const overrideTrimmed = totalCostOverride.trim();
    const parsedOverride =
      overrideTrimmed === "" ? null : Number(overrideTrimmed);
    const totalCostOverrideForBody =
      parsedOverride !== null && Number.isFinite(parsedOverride) && parsedOverride >= 0
        ? parsedOverride
        : null;

    setStep(4);
    const r = await importApi.execute(
      `/api/campaigns/${campaignId}/stages/${stageId}/import`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csv_content: csvText,
          mapping: mappingColumns,
          status_value_map: rawToStatusMap(statusRaw) ?? undefined,
          mapping_id: mappingIdToUse,
          filename: file?.name ?? null,
          total_cost_override: totalCostOverrideForBody,
          confirm: true,
        }),
      },
    );
    if (r.ok) {
      setImportResult(r.data);
      toast.success(
        `Imported ${r.data.processed_rows.toLocaleString()} rows.`,
      );
    } else {
      toastApiError(r);
      setStep(3); // back to preview so they can retry
    }
  }

  // =============== Render ===============

  return (
    <div className="grid gap-4">
      <StepIndicator step={step} />

      {step === 1 ? (
        <section className="grid gap-3">
          <Label>
            Results CSV file
            <span aria-hidden className="text-destructive ml-0.5">*</span>
          </Label>
          <FileDropZone
            accept=".csv,text/csv,text/plain"
            hint="Click to select or drag a CSV file here"
            onFile={(f) => handleFile(f)}
            selectedSummary={
              file
                ? { name: file.name, meta: `${(file.size / 1024).toFixed(1)} KB` }
                : null
            }
          />
          {fileError ? (
            <p className="text-sm text-destructive">{fileError}</p>
          ) : null}
          {previewRows.length > 0 ? (
            <Card>
              <CardContent className="overflow-auto pt-6">
                <p className="mb-2 text-xs uppercase text-muted-foreground">
                  Preview — first {previewRows.length} rows
                </p>
                <table className="min-w-full text-xs">
                  <thead className="border-b">
                    <tr>
                      {headerColumns.map((h) => (
                        <th key={h} className="px-2 py-1 text-left font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row, i) => (
                      <tr key={i} className="border-b last:border-b-0">
                        {headerColumns.map((h) => (
                          <td
                            key={h}
                            className="px-2 py-1 font-mono text-muted-foreground"
                          >
                            {row[h] ?? ""}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!file || headerColumns.length === 0}
              onClick={() => setStep(2)}
            >
              Next: Configure mapping
            </Button>
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section className="grid gap-4">
          {savedMappings.length > 0 ? (
            <div className="grid gap-2">
              <Label>Saved mapping</Label>
              <Select
                value={selectedMappingId !== null ? String(selectedMappingId) : NONE}
                onValueChange={onPickSavedMapping}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a saved mapping or configure manually" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Configure manually</SelectItem>
                  {savedMappings.map((m) => (
                    <SelectItem key={m.id} value={String(m.id)}>
                      {m.name}
                      {m.is_default ? " · default" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="grid gap-3 rounded-md border p-4">
            {CANONICAL_ORDER.map((key) => (
              <div key={key} className="grid gap-1.5">
                <Label className="text-xs">
                  {CANONICAL_LABELS[key]}
                  {REQUIRED_CANONICAL.has(key) ? (
                    <span aria-hidden className="text-destructive ml-0.5">
                      *
                    </span>
                  ) : null}
                </Label>
                <Select
                  value={mappingColumns[key] ?? NONE}
                  onValueChange={(v) => setColumn(key, v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Not in CSV" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Not in CSV</SelectItem>
                    {headerColumns.map((h) => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>

          {/* Status value mapping — only relevant when a Status column is set. */}
          {mappingColumns.status ? (
            <div className="grid gap-3 rounded-md border p-4">
              <div className="grid gap-0.5">
                <Label className="text-sm font-medium">
                  Status value mapping
                </Label>
                <p className="text-xs text-muted-foreground">
                  List the values your provider puts in the{" "}
                  <span className="font-mono">
                    &ldquo;{mappingColumns.status}&rdquo;
                  </span>{" "}
                  column for each outcome (comma-separated, case-insensitive).
                  Leave a row blank to use built-in detection.
                </p>
              </div>
              {STATUS_MAP_OUTCOMES.map(({ key, label, eg }) => (
                <div
                  key={key}
                  className="grid gap-1.5 sm:grid-cols-[110px_1fr] sm:items-center sm:gap-3"
                >
                  <Label className="text-xs">{label}</Label>
                  <Input
                    value={statusRaw[key] ?? ""}
                    placeholder={`e.g. ${eg}`}
                    onChange={(e) =>
                      setStatusRaw((prev) => ({
                        ...prev,
                        [key]: e.target.value,
                      }))
                    }
                  />
                </div>
              ))}
            </div>
          ) : null}

          <div className="grid gap-1.5 rounded-md border p-4">
            <Label htmlFor="total-cost-override" className="text-xs">
              Total cost (USD)
            </Label>
            <div className="relative">
              <span
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
              >
                $
              </span>
              <Input
                id="total-cost-override"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                placeholder="0.00"
                value={totalCostOverride}
                onChange={(e) => setTotalCostOverride(e.target.value)}
                className="pl-6"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Optional. When set, this overrides the per-row cost summed
              from the CSV — useful when the provider reports a single
              lump-sum charge instead of per-message pricing.
            </p>
          </div>

          {selectedMappingId === null && stage.sms_provider_id !== null ? (
            <div className="grid gap-2 rounded-md border bg-muted/30 p-4">
              <div className="flex items-center gap-2">
                <Switch
                  id="save-as-mapping"
                  checked={saveAsMapping}
                  onCheckedChange={(v) => setSaveAsMapping(v === true)}
                />
                <Label htmlFor="save-as-mapping" className="cursor-pointer">
                  Save this mapping for future imports from this provider
                </Label>
              </div>
              {saveAsMapping ? (
                <Input
                  placeholder="Mapping name"
                  value={saveAsName}
                  onChange={(e) => setSaveAsName(e.target.value)}
                />
              ) : null}
            </div>
          ) : null}

          <div className="flex justify-between gap-2 pt-2">
            <Button variant="outline" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button
              disabled={!mappingValid || previewApi.isLoading}
              onClick={runPreview}
            >
              {previewApi.isLoading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : null}
              Next: Preview import
            </Button>
          </div>
        </section>
      ) : null}

      {step === 3 && preview ? (
        <section className="grid gap-4">
          <Card>
            <CardContent className="grid gap-3 pt-6">
              <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                <Metric label="Submitted" value={preview.submitted} />
                <Metric label="Parsed" value={preview.parsed} />
                <Metric label="Invalid phone" value={preview.invalid_phone} />
                <Metric label="Unique numbers" value={preview.unique_numbers} />
                <Metric
                  label="Duplicates merged"
                  value={preview.events_collapsed}
                />
                <Metric label="Already imported" value={preview.existing_in_db} />
              </div>
              {preview.events_collapsed > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {preview.events_collapsed.toLocaleString()} duplicate row
                  {preview.events_collapsed === 1 ? "" : "s"} collapsed by
                  priority: opt-out &gt; scrubbed &gt; bounced &gt; clicker
                  &gt; delivered &gt; failed &gt; no-op. Bucket counts below
                  reflect the winning outcome per number.
                </p>
              ) : null}
              <div className="grid grid-cols-2 gap-2 border-t pt-3 text-sm sm:grid-cols-4">
                <Metric label="Delivered" value={preview.by_outcome.delivered} />
                <Metric label="Failed" value={preview.by_outcome.failed} />
                <Metric label="Opt-outs" value={preview.by_outcome.optout} />
                <Metric label="Clickers" value={preview.by_outcome.clicker} />
                <Metric label="Scrubbed" value={preview.by_outcome.scrubbed} />
                <Metric label="Bounced" value={preview.by_outcome.bounced} />
                <Metric label="No-op" value={preview.by_outcome.noop} />
              </div>
            </CardContent>
          </Card>

          {preview.sample_rows.length > 0 ? (
            <Card>
              <CardContent className="overflow-auto pt-6">
                <p className="mb-2 text-xs uppercase text-muted-foreground">
                  Sample classifications (5 per bucket)
                </p>
                <table className="min-w-full text-xs">
                  <thead className="border-b">
                    <tr>
                      <th className="px-2 py-1 text-left">Outcome</th>
                      <th className="px-2 py-1 text-left">Phone</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.sample_rows.map((r, i) => (
                      <tr key={i} className="border-b last:border-b-0">
                        <td className="px-2 py-1 capitalize">{r.outcome}</td>
                        <td className="px-2 py-1 font-mono">{r.phone_number}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ) : null}

          <div className="flex justify-between gap-2 pt-2">
            <Button variant="outline" onClick={() => setStep(2)}>
              Back to mapping
            </Button>
            <Button
              disabled={importApi.isLoading || preview.unique_numbers === 0}
              onClick={runImport}
            >
              Import {preview.unique_numbers.toLocaleString()} rows
            </Button>
          </div>
        </section>
      ) : null}

      {step === 4 ? (
        <section className="grid gap-4">
          {importApi.isLoading || !importResult ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-10">
                <Loader2
                  className="size-6 animate-spin text-muted-foreground"
                  aria-hidden
                />
                <p className="text-sm text-muted-foreground">Importing…</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="grid gap-3 pt-6">
                <p className="text-sm font-medium">Import complete</p>
                <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                  <Metric
                    label="Processed"
                    value={importResult.processed_rows}
                  />
                  <Metric
                    label="Skipped (idempotent)"
                    value={importResult.skipped_idempotent}
                  />
                  <Metric label="Delivered" value={importResult.delivered_added} />
                  <Metric label="Failed" value={importResult.failed_added} />
                  <Metric label="Opt-outs" value={importResult.optouts_added} />
                  <Metric
                    label="Clickers"
                    value={importResult.clickers_added}
                  />
                  <Metric label="Scrubbed" value={importResult.scrubbed_added} />
                  <Metric label="Bounced" value={importResult.bounced_added} />
                </div>
              </CardContent>
            </Card>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              disabled={importApi.isLoading}
              onClick={() => {
                onComplete();
                onClose();
              }}
            >
              Close
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

// =============== Subcomponents ===============

function StepIndicator({ step }: { step: 1 | 2 | 3 | 4 }) {
  const labels = ["File", "Mapping", "Preview", "Import"] as const;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {labels.map((l, i) => {
        const n = (i + 1) as 1 | 2 | 3 | 4;
        const active = n === step;
        const done = n < step;
        return (
          <div key={l} className="flex items-center gap-2">
            <span
              className={
                active
                  ? "rounded-full bg-foreground px-2 py-0.5 text-background"
                  : done
                    ? "rounded-full bg-muted px-2 py-0.5 text-foreground"
                    : "rounded-full border px-2 py-0.5"
              }
            >
              {n}. {l}
            </span>
            {i < 3 ? <span>→</span> : null}
          </div>
        );
      })}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="font-mono text-lg tabular-nums">
        {value.toLocaleString()}
      </div>
    </div>
  );
}
