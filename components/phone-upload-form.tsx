"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Upload } from "lucide-react";
import Papa from "papaparse";
import { toast } from "sonner";

import { FileDropZone } from "@/components/file-drop-zone";
import { MultiSelectPicker } from "@/components/multi-select-picker";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { cn } from "@/lib/utils";

// Review-panel shape from POST /api/telnyx/lookup/preview.
type LookupPreview = {
  rows_in_file: number;
  unique_numbers: number;
  valid: number;
  invalid: number;
  cached: number;
  new_lookups: number;
  est_cost_usd: number;
  balance_usd: number | null;
  balance_error?: string | null;
};

type LookupEnqueueResult = {
  batchId: string;
  total: number;
  cacheHits: number;
  enqueued: number;
  estCostUsd: number;
};

function formatUsd(n: number): string {
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

export type UploadResultSummary = {
  submitted: number;
  valid: number;
  invalid: number;
  duplicates_in_input: number;
  duplicates_in_db: number;
  inserted: number;
  invalid_samples: { input: string; error: string }[];
  // Optional: present on endpoints that participate in the group-tagging
  // pipeline (contacts/upload, opt-outs/upload, etc.) when the user
  // selected groups in the form below. Total new (contact, group) rows
  // inserted across the upload.
  groups_applied?: number;
  // Optional: distinct count of *already-existing* contacts that gained
  // at least one new group membership. Same endpoints as `groups_applied`.
  updated_contacts?: number;
};

type ContactGroupOption = {
  id: number;
  name: string;
  color: string | null;
};

export interface PhoneUploadFormProps {
  endpoint: string;
  // Extra body fields merged into the request payload alongside `phones`.
  // Used e.g. for opt-outs (brand_id), opt-ins, etc.
  additionalFields?: Record<string, unknown>;
  onSuccess?: (result: UploadResultSummary) => void;
  onCancel: () => void;
  submitLabel?: string;
  successLabel?: string;
  acceptCsv?: boolean;
  // When true, render a contact-groups multi-select above the phones
  // input. Selected group IDs are sent as `assign_to_group_ids` on submit.
  // Caller is responsible for ensuring the endpoint supports the field.
  enableContactGroups?: boolean;
  // When true (only valid alongside enableContactGroups), block submit
  // until at least one group is selected and surface a required-field
  // marker. Used by the contacts upload to enforce the policy that every
  // contact must land in a group.
  requireContactGroups?: boolean;
  // When true, render a "Run carrier lookup via Telnyx" checkbox (default
  // checked). When checked, submit first shows a cost/coverage review panel,
  // then on confirm runs the normal upload and best-effort enqueues a Telnyx
  // lookup for the numbers. Never set this on the opt-outs path — those
  // numbers are never messaged.
  enableLookup?: boolean;
}

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;
const PREVIEW_COUNT = 5;
const PHONE_COLUMN_CANDIDATES = ["phone", "phone_number", "number"];

function detectPhoneColumn(
  headerRow: string[] | null | undefined,
): number | null {
  if (!headerRow) return null;
  for (let i = 0; i < headerRow.length; i++) {
    const key = String(headerRow[i] ?? "").trim().toLowerCase();
    if (PHONE_COLUMN_CANDIDATES.includes(key)) return i;
  }
  return null;
}

export function PhoneUploadForm({
  endpoint,
  additionalFields,
  onSuccess,
  onCancel,
  submitLabel = "Upload contacts",
  successLabel = "Uploaded successfully",
  acceptCsv = true,
  enableContactGroups = false,
  requireContactGroups = false,
  enableLookup = false,
}: PhoneUploadFormProps) {
  const uploadApi = useApiCall<UploadResultSummary>();
  const previewApi = useApiCall<LookupPreview>();
  const enqueueApi = useApiCall<LookupEnqueueResult>();
  const contactGroupsApi = useApiCall<{ data: ContactGroupOption[] }>();
  const [pasteValue, setPasteValue] = useState("");
  const [csvLines, setCsvLines] = useState<string[]>([]);
  const [csvSourceName, setCsvSourceName] = useState<string | null>(null);
  const [csvPreview, setCsvPreview] = useState<string[]>([]);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"paste" | "csv">("paste");
  const [result, setResult] = useState<UploadResultSummary | null>(null);
  const [showInvalid, setShowInvalid] = useState(false);
  const [contactGroups, setContactGroups] = useState<ContactGroupOption[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>([]);
  // Carrier-lookup flow state. `runLookup` defaults to enableLookup so the
  // box starts checked. `lookupPreview` (when set) swaps the input screen for
  // the review panel; `pendingPhones` holds the exact payload to upload +
  // enqueue on confirm.
  const [runLookup, setRunLookup] = useState(enableLookup);
  const [lookupPreview, setLookupPreview] = useState<LookupPreview | null>(null);
  const [pendingPhones, setPendingPhones] = useState<string | null>(null);

  // Lazy-load contact groups only when the multi-select is rendered.
  useEffect(() => {
    if (!enableContactGroups) return;
    let cancelled = false;
    (async () => {
      const r = await contactGroupsApi.execute(
        "/api/contact-groups/list?pageSize=200",
      );
      if (cancelled) return;
      if (r.ok) setContactGroups(r.data.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [enableContactGroups, contactGroupsApi.execute]);

  function reset() {
    setPasteValue("");
    setCsvLines([]);
    setCsvSourceName(null);
    setCsvPreview([]);
    setCsvError(null);
    setResult(null);
    setShowInvalid(false);
    setSelectedGroupIds([]);
    setRunLookup(enableLookup);
    setLookupPreview(null);
    setPendingPhones(null);
  }

  function handleFileSelect(file: File) {
    setCsvError(null);
    setCsvLines([]);
    setCsvPreview([]);
    setCsvSourceName(file.name);

    if (file.size > MAX_PAYLOAD_BYTES) {
      setCsvError(
        `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 5MB.`,
      );
      return;
    }

    Papa.parse<string[]>(file, {
      skipEmptyLines: true,
      complete: (parsed) => {
        const rows = parsed.data as string[][];
        if (rows.length === 0) {
          setCsvError("File is empty.");
          return;
        }
        const headerIdx = detectPhoneColumn(rows[0]);
        const dataRows = headerIdx !== null ? rows.slice(1) : rows;
        const col = headerIdx !== null ? headerIdx : 0;
        const values = dataRows
          .map((r) => (r[col] ?? "").trim())
          .filter((s) => s.length > 0);
        if (values.length === 0) {
          setCsvError("No phone numbers found in the file.");
          return;
        }
        setCsvLines(values);
        setCsvPreview(values.slice(0, PREVIEW_COUNT));
      },
      error: (err) => {
        setCsvError(err.message || "Couldn't parse the file.");
      },
    });
  }

  function resolvePhones(): string | null {
    const phones =
      activeTab === "paste" ? pasteValue.trim() : csvLines.join("\n");
    if (!phones) return null;
    if (phones.length > MAX_PAYLOAD_BYTES) {
      setCsvError(
        `Payload too large (${(phones.length / 1024 / 1024).toFixed(1)}MB). Max 5MB.`,
      );
      return null;
    }
    return phones;
  }

  // The real upload against the caller's endpoint. Returns true on success.
  async function runUpload(phones: string): Promise<boolean> {
    // Include assign_to_group_ids when the user selected at least one
    // group. Omit the field entirely when empty so the endpoint can keep
    // its no-group fast path.
    const body: Record<string, unknown> = {
      phones,
      ...(additionalFields ?? {}),
    };
    if (enableContactGroups && selectedGroupIds.length > 0) {
      body.assign_to_group_ids = selectedGroupIds;
    }

    const result = await uploadApi.execute(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!result.ok) {
      toastApiError(result, "Upload failed");
      return false;
    }
    setResult(result.data);
    onSuccess?.(result.data);
    return true;
  }

  async function handleSubmit() {
    setResult(null);
    const phones = resolvePhones();
    if (!phones) return;

    // Lookup enabled + checked: fetch the cost/coverage preview and show the
    // review panel. The actual upload waits for confirm.
    if (enableLookup && runLookup) {
      const pr = await previewApi.execute("/api/telnyx/lookup/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phones }),
      });
      if (!pr.ok) {
        toastApiError(pr, "Couldn't preview carrier lookup");
        return;
      }
      setPendingPhones(phones);
      setLookupPreview(pr.data);
      return;
    }

    await runUpload(phones);
  }

  // Confirm from the review panel: run the upload, then best-effort enqueue a
  // Telnyx lookup for the same numbers. Enqueue failure never blocks the
  // upload result — the contacts are already saved.
  async function handleConfirmUpload() {
    if (!pendingPhones) return;
    const ok = await runUpload(pendingPhones);
    if (!ok) return;
    const eq = await enqueueApi.execute("/api/telnyx/lookup/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phones: pendingPhones }),
    });
    if (eq.ok) {
      toast.success(
        `Queued ${eq.data.enqueued.toLocaleString()} number${
          eq.data.enqueued === 1 ? "" : "s"
        } for carrier lookup`,
      );
    } else {
      toast.warning(
        "Contacts uploaded, but the carrier lookup couldn't be queued. Retry from the lookup admin page.",
      );
    }
    setLookupPreview(null);
    setPendingPhones(null);
  }

  const phonesProvided =
    (activeTab === "paste" && pasteValue.trim().length > 0) ||
    (activeTab === "csv" && csvLines.length > 0);
  const groupsSatisfied = !requireContactGroups || selectedGroupIds.length > 0;
  const submitBusy = uploadApi.isLoading || previewApi.isLoading;
  const canSubmit = !submitBusy && phonesProvided && groupsSatisfied;

  // === Result screen ===
  if (result) {
    return (
      <div className="grid gap-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CheckCircle2
            className="size-5 text-emerald-600"
            aria-hidden
          />
          {successLabel}
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
          <Stat label="Submitted" value={result.submitted} />
          <Stat label="Valid" value={result.valid} />
          <Stat label="Invalid" value={result.invalid} tone="warn" />
          <Stat label="Inserted" value={result.inserted} tone="success" />
          <Stat
            label="Duplicates (in DB)"
            value={result.duplicates_in_db}
            tone="muted"
          />
          <Stat
            label="Duplicates (in input)"
            value={result.duplicates_in_input}
            tone="muted"
          />
          {typeof result.updated_contacts === "number" &&
          result.updated_contacts > 0 ? (
            <Stat
              label="Updated contacts"
              value={result.updated_contacts}
              tone="success"
            />
          ) : null}
          {typeof result.groups_applied === "number" &&
          result.groups_applied > 0 ? (
            <Stat
              label="New group tags"
              value={result.groups_applied}
              tone="success"
            />
          ) : null}
        </div>

        {result.invalid_samples.length > 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
            <button
              type="button"
              onClick={() => setShowInvalid((v) => !v)}
              className="font-medium text-amber-800 dark:text-amber-200"
            >
              {showInvalid ? "Hide" : "Show"} invalid entries (
              {result.invalid_samples.length}
              {result.invalid > result.invalid_samples.length
                ? ` of ${result.invalid}`
                : ""}
              )
            </button>
            {showInvalid ? (
              <ul className="mt-2 grid gap-1 text-xs">
                {result.invalid_samples.map((s, i) => (
                  <li key={i} className="font-mono">
                    <span className="text-amber-900 dark:text-amber-200">
                      {s.input || "(empty)"}
                    </span>
                    <span className="ml-2 text-amber-700 dark:text-amber-400">
                      — {s.error}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="outline" onClick={reset}>
            Upload another batch
          </Button>
          <Button onClick={onCancel}>Done</Button>
        </div>
      </div>
    );
  }

  // === Review screen (lookup enabled + checked) ===
  if (lookupPreview) {
    const p = lookupPreview;
    const insufficient =
      p.balance_usd !== null && p.balance_usd < p.est_cost_usd;
    const busy = uploadApi.isLoading || enqueueApi.isLoading;
    return (
      <div className="grid gap-4">
        <div className="text-sm font-medium">Review carrier lookup</div>

        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          <span className="font-mono tabular-nums text-foreground">
            {p.rows_in_file.toLocaleString()}
          </span>{" "}
          {p.rows_in_file === 1 ? "row" : "rows"} →{" "}
          <span className="font-mono tabular-nums text-foreground">
            {p.unique_numbers.toLocaleString()}
          </span>{" "}
          unique number{p.unique_numbers === 1 ? "" : "s"}
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Valid" value={p.valid} tone="success" />
          <Stat label="Invalid" value={p.invalid} tone="warn" />
          <Stat label="Cached (free)" value={p.cached} tone="muted" />
          <Stat label="New lookups" value={p.new_lookups} />
        </div>

        <div className="grid gap-2 rounded-md border p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Estimated cost</span>
            <span className="font-mono font-semibold tabular-nums">
              {formatUsd(p.est_cost_usd)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Telnyx balance</span>
            {p.balance_usd === null ? (
              <span className="text-muted-foreground">Unavailable</span>
            ) : (
              <span
                className={cn(
                  "font-mono tabular-nums",
                  insufficient && "font-semibold text-destructive",
                )}
              >
                {formatUsd(p.balance_usd)}
              </span>
            )}
          </div>
          {insufficient ? (
            <p className="flex items-center gap-1.5 text-xs text-destructive">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
              Estimated cost exceeds the available Telnyx balance. Top up
              before running, or uncheck lookup to upload without it.
            </p>
          ) : null}
          {p.balance_usd === null && p.balance_error ? (
            <p className="text-xs text-muted-foreground">
              Couldn&apos;t read balance: {p.balance_error}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            variant="outline"
            onClick={() => {
              setLookupPreview(null);
              setPendingPhones(null);
            }}
            disabled={busy}
          >
            Back
          </Button>
          <Button onClick={() => void handleConfirmUpload()} disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Uploading…
              </>
            ) : (
              <>
                <Upload className="size-4" aria-hidden />
                Confirm &amp; upload
              </>
            )}
          </Button>
        </div>
      </div>
    );
  }

  // === Input screen ===
  return (
    <div className="grid gap-4">
      {enableContactGroups ? (
        <div className="grid gap-2">
          <Label>
            Apply contact groups
            {requireContactGroups ? (
              <span aria-hidden className="text-destructive ml-0.5">
                *
              </span>
            ) : null}
          </Label>
          <MultiSelectPicker
            options={contactGroups.map((g) => ({
              id: g.id,
              label: g.name,
              color: g.color,
            }))}
            value={selectedGroupIds}
            onChange={(next) => setSelectedGroupIds(next as number[])}
            placeholder="Select contact groups…"
            selectedLabel={(n) =>
              `${n.toLocaleString()} group${n === 1 ? "" : "s"} selected`
            }
            isLoading={contactGroupsApi.isLoading && contactGroups.length === 0}
            disabled={uploadApi.isLoading}
            emptyMessage="No contact groups exist yet."
            searchPlaceholder="Search groups…"
          />
          <p className="text-xs text-muted-foreground">
            {requireContactGroups
              ? "At least one contact group is required. Every uploaded contact will be tagged with the selected groups."
              : "Every uploaded contact will be tagged with the selected groups."}
          </p>
          {requireContactGroups &&
          selectedGroupIds.length === 0 &&
          phonesProvided ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Select at least one contact group to enable upload.
            </p>
          ) : null}
        </div>
      ) : null}

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as "paste" | "csv")}
      >
        <TabsList>
          <TabsTrigger value="paste">Paste</TabsTrigger>
          {acceptCsv ? (
            <TabsTrigger value="csv">CSV file</TabsTrigger>
          ) : null}
        </TabsList>

        <TabsContent value="paste" className="grid gap-2 pt-3">
          <Label htmlFor="phones-paste">
            Phone numbers
            <span aria-hidden className="text-destructive ml-0.5">*</span>
          </Label>
          <Textarea
            id="phones-paste"
            placeholder="+1 202 555 0199&#10;+1 202 555 0200&#10;..."
            rows={10}
            value={pasteValue}
            onChange={(e) => setPasteValue(e.target.value)}
            disabled={uploadApi.isLoading}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            One phone per line. Commas and semicolons also work. US numbers
            without a country code will be auto-prepended with +1.
          </p>
        </TabsContent>

        {acceptCsv ? (
          <TabsContent value="csv" className="grid gap-2 pt-3">
            <Label>
              CSV / TXT file
              <span aria-hidden className="text-destructive ml-0.5">*</span>
            </Label>
            <FileDropZone
              accept=".csv,.txt"
              disabled={uploadApi.isLoading}
              hint="Click to select or drag a CSV/TXT file here"
              onFile={handleFileSelect}
              selectedSummary={
                csvSourceName && !csvError && csvLines.length > 0
                  ? {
                      name: csvSourceName,
                      meta: `${csvLines.length} ${csvLines.length === 1 ? "row" : "rows"}`,
                    }
                  : null
              }
            />
            {csvError ? (
              <p className="text-sm text-destructive">{csvError}</p>
            ) : null}
            {csvPreview.length > 0 && !csvError ? (
              <div className="rounded-md border bg-muted/40 p-3 text-xs">
                <div className="text-muted-foreground">Preview</div>
                <div className="mt-1 grid gap-0.5 font-mono">
                  {csvPreview.map((p, i) => (
                    <div key={i}>{p}</div>
                  ))}
                  {csvLines.length > PREVIEW_COUNT ? (
                    <div className="italic text-muted-foreground">
                      …and {csvLines.length - PREVIEW_COUNT} more
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              First column or a column named <code>phone</code>,{" "}
              <code>phone_number</code>, or <code>number</code> is used. Header
              row is auto-detected.
            </p>
          </TabsContent>
        ) : null}
      </Tabs>

      {enableLookup ? (
        <label className="flex cursor-pointer items-start gap-2 rounded-md border bg-muted/20 p-3">
          <input
            type="checkbox"
            checked={runLookup}
            onChange={(e) => setRunLookup(e.target.checked)}
            disabled={submitBusy}
            className="mt-0.5 size-4 cursor-pointer"
          />
          <span className="grid gap-0.5">
            <span className="text-sm font-medium">
              Run carrier lookup via Telnyx
            </span>
            <span className="text-xs text-muted-foreground">
              Detects each number&apos;s line type and carrier. You&apos;ll see
              a cost estimate before anything runs; numbers already looked up
              are free.
            </span>
          </span>
        </label>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={submitBusy}
        >
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={!canSubmit}>
          {previewApi.isLoading ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Checking…
            </>
          ) : uploadApi.isLoading ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Uploading…
            </>
          ) : (
            <>
              <Upload className="size-4" aria-hidden />
              {enableLookup && runLookup ? "Review & upload" : submitLabel}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "warn" | "success" | "muted";
}) {
  return (
    <div className="rounded-md border bg-background p-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "warn" && "text-amber-700 dark:text-amber-400",
          tone === "success" && "text-emerald-700 dark:text-emerald-400",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}
