"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Loader2, Upload } from "lucide-react";
import Papa from "papaparse";

import { FileDropZone } from "@/components/file-drop-zone";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import {
  CONTACT_STATUS_LABELS,
  mapContactStatus,
  type ContactStatusReason,
} from "@/lib/imports/contact-status";
import { cn } from "@/lib/utils";

export type ContactStatusImportSummary = {
  submitted: number;
  recognized: number;
  invalid_phone: number;
  unknown_status: number;
  duplicates_in_input: number;
  contacts_affected: number;
  applied: number;
  already_set: number;
  by_reason: Record<ContactStatusReason, number>;
  invalid_samples: { input: string; error: string }[];
  skipped_samples: { input: string; error: string }[];
};

type ImportRow = { phone: string; status: string };

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;
const PREVIEW_COUNT = 6;
const PHONE_COLUMN_CANDIDATES = [
  "phone",
  "phone_number",
  "number",
  "mobile",
  "msisdn",
  "cell",
];
const STATUS_COLUMN_CANDIDATES = [
  "status",
  "contact_status",
  "phone_status",
  "disposition",
  "state",
  "type",
  "reason",
  "result",
];

function findColumn(
  headerRow: string[] | null | undefined,
  candidates: string[],
): number | null {
  if (!headerRow) return null;
  for (let i = 0; i < headerRow.length; i++) {
    const key = String(headerRow[i] ?? "")
      .trim()
      .toLowerCase();
    if (candidates.includes(key)) return i;
  }
  return null;
}

// Split a pasted line into [phone, status] on the first comma / tab / semicolon.
function splitPastedLine(line: string): ImportRow | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[\t,;]+/);
  const phone = (parts[0] ?? "").trim();
  if (!phone) return null;
  const status = (parts[1] ?? "").trim();
  return { phone, status };
}

const REASON_BADGE: Record<ContactStatusReason, string> = {
  opt_out:
    "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  suppressed:
    "border-rose-200 bg-rose-100 text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200",
  scrubbed:
    "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300",
};

export interface ContactStatusImportFormProps {
  onSuccess?: (result: ContactStatusImportSummary) => void;
  onCancel: () => void;
}

export function ContactStatusImportForm({
  onSuccess,
  onCancel,
}: ContactStatusImportFormProps) {
  const importApi = useApiCall<ContactStatusImportSummary>();
  const [activeTab, setActiveTab] = useState<"paste" | "csv">("csv");
  const [pasteValue, setPasteValue] = useState("");
  const [csvRows, setCsvRows] = useState<ImportRow[]>([]);
  const [csvSourceName, setCsvSourceName] = useState<string | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [result, setResult] = useState<ContactStatusImportSummary | null>(null);
  const [showInvalid, setShowInvalid] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);

  const pasteRows = useMemo<ImportRow[]>(() => {
    if (activeTab !== "paste") return [];
    return pasteValue
      .split(/\r?\n/)
      .map(splitPastedLine)
      .filter((r): r is ImportRow => r !== null);
  }, [activeTab, pasteValue]);

  const rows = activeTab === "csv" ? csvRows : pasteRows;

  // Client-side preview of how the smart reader will classify each row. Uses
  // the SAME mapper the server uses, so the preview can't drift from the result.
  const preview = useMemo(
    () =>
      rows.slice(0, PREVIEW_COUNT).map((r) => ({
        ...r,
        reason: mapContactStatus(r.status),
      })),
    [rows],
  );

  function reset() {
    setPasteValue("");
    setCsvRows([]);
    setCsvSourceName(null);
    setCsvError(null);
    setResult(null);
    setShowInvalid(false);
    setShowSkipped(false);
  }

  function handleFileSelect(file: File) {
    setCsvError(null);
    setCsvRows([]);
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
        const data = parsed.data as string[][];
        if (data.length === 0) {
          setCsvError("File is empty.");
          return;
        }
        const phoneIdx = findColumn(data[0], PHONE_COLUMN_CANDIDATES);
        const statusIdx = findColumn(data[0], STATUS_COLUMN_CANDIDATES);
        const hasHeader = phoneIdx !== null || statusIdx !== null;
        const dataRows = hasHeader ? data.slice(1) : data;
        const pCol = phoneIdx ?? 0;
        const sCol = statusIdx ?? 1;
        const out: ImportRow[] = [];
        for (const r of dataRows) {
          const phone = (r[pCol] ?? "").trim();
          if (!phone) continue;
          out.push({ phone, status: (r[sCol] ?? "").trim() });
        }
        if (out.length === 0) {
          setCsvError("No phone numbers found in the file.");
          return;
        }
        setCsvRows(out);
      },
      error: (err) => {
        setCsvError(err.message || "Couldn't parse the file.");
      },
    });
  }

  async function handleSubmit() {
    setResult(null);
    if (rows.length === 0) return;

    const r = await importApi.execute("/api/contacts/statuses/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    if (!r.ok) {
      toastApiError(r, "Import failed");
      return;
    }
    setResult(r.data);
    onSuccess?.(r.data);
  }

  const canSubmit = !importApi.isLoading && rows.length > 0;

  // === Result screen ===
  if (result) {
    return (
      <div className="grid gap-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CheckCircle2 className="size-5 text-emerald-600" aria-hidden />
          Statuses imported
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
          <Stat label="Rows submitted" value={result.submitted} />
          <Stat
            label="Statuses applied"
            value={result.applied}
            tone="success"
          />
          <Stat
            label="Contacts affected"
            value={result.contacts_affected}
            tone="success"
          />
          <Stat label="Opt-outs" value={result.by_reason.opt_out} />
          <Stat label="Suppressed" value={result.by_reason.suppressed} />
          <Stat label="Scrubbed" value={result.by_reason.scrubbed} />
          <Stat
            label="Already set"
            value={result.already_set}
            tone="muted"
          />
          <Stat
            label="Invalid phones"
            value={result.invalid_phone}
            tone="warn"
          />
          <Stat
            label="Unknown status"
            value={result.unknown_status}
            tone="warn"
          />
        </div>

        {result.invalid_samples.length > 0 ? (
          <SampleList
            title={`invalid phones (${result.invalid_samples.length}${
              result.invalid_phone > result.invalid_samples.length
                ? ` of ${result.invalid_phone}`
                : ""
            })`}
            open={showInvalid}
            onToggle={() => setShowInvalid((v) => !v)}
            samples={result.invalid_samples}
          />
        ) : null}

        {result.skipped_samples.length > 0 ? (
          <SampleList
            title={`unrecognized statuses (${result.skipped_samples.length}${
              result.unknown_status > result.skipped_samples.length
                ? ` of ${result.unknown_status}`
                : ""
            })`}
            open={showSkipped}
            onToggle={() => setShowSkipped((v) => !v)}
            samples={result.skipped_samples}
          />
        ) : null}

        <p className="text-xs text-muted-foreground">
          Imported statuses exclude these contacts from{" "}
          <strong>future</strong> campaigns only. Campaigns already created keep
          their locked audience unchanged.
        </p>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="outline" onClick={reset}>
            Import another file
          </Button>
          <Button onClick={onCancel}>Done</Button>
        </div>
      </div>
    );
  }

  // === Input screen ===
  return (
    <div className="grid gap-4">
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as "paste" | "csv")}
      >
        <TabsList>
          <TabsTrigger value="csv">CSV file</TabsTrigger>
          <TabsTrigger value="paste">Paste</TabsTrigger>
        </TabsList>

        <TabsContent value="csv" className="grid gap-2 pt-3">
          <Label>
            CSV file
            <span aria-hidden className="text-destructive ml-0.5">
              *
            </span>
          </Label>
          <FileDropZone
            accept=".csv,.txt"
            disabled={importApi.isLoading}
            hint="Click to select or drag a CSV file here"
            onFile={handleFileSelect}
            selectedSummary={
              csvSourceName && !csvError && csvRows.length > 0
                ? {
                    name: csvSourceName,
                    meta: `${csvRows.length} ${csvRows.length === 1 ? "row" : "rows"}`,
                  }
                : null
            }
          />
          {csvError ? (
            <p className="text-sm text-destructive">{csvError}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Needs a phone column (<code>phone</code>, <code>phone_number</code>,{" "}
            <code>number</code>…) and a status column (<code>status</code>,{" "}
            <code>type</code>, <code>disposition</code>…). Header row is
            auto-detected; otherwise the first column is the phone and the second
            is the status.
          </p>
        </TabsContent>

        <TabsContent value="paste" className="grid gap-2 pt-3">
          <Label htmlFor="status-paste">
            Phone, status
            <span aria-hidden className="text-destructive ml-0.5">
              *
            </span>
          </Label>
          <Textarea
            id="status-paste"
            placeholder={"+1 202 555 0199, Unsubscribed\n+1 202 555 0200, Landline\n+1 202 555 0201, Suppressed"}
            rows={8}
            value={pasteValue}
            onChange={(e) => setPasteValue(e.target.value)}
            disabled={importApi.isLoading}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            One contact per line: phone, then status, separated by a comma or
            tab.
          </p>
        </TabsContent>
      </Tabs>

      {preview.length > 0 ? (
        <div className="rounded-md border bg-muted/40 p-3 text-xs">
          <div className="mb-1 text-muted-foreground">
            Preview — how each status will be read
          </div>
          <div className="grid gap-1">
            {preview.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="font-mono">{p.phone}</span>
                <span className="text-muted-foreground">→</span>
                {p.reason ? (
                  <span
                    className={cn(
                      "inline-flex items-center rounded-md border px-1.5 py-0.5",
                      REASON_BADGE[p.reason],
                    )}
                  >
                    {CONTACT_STATUS_LABELS[p.reason]}
                  </span>
                ) : (
                  <span className="italic text-amber-700 dark:text-amber-400">
                    {p.status ? `unrecognized ("${p.status}")` : "no status — skipped"}
                  </span>
                )}
              </div>
            ))}
            {rows.length > PREVIEW_COUNT ? (
              <div className="italic text-muted-foreground">
                …and {(rows.length - PREVIEW_COUNT).toLocaleString()} more
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={importApi.isLoading}
        >
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={!canSubmit}>
          {importApi.isLoading ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Importing…
            </>
          ) : (
            <>
              <Upload className="size-4" aria-hidden />
              Import statuses
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function SampleList({
  title,
  open,
  onToggle,
  samples,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  samples: { input: string; error: string }[];
}) {
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
      <button
        type="button"
        onClick={onToggle}
        className="font-medium text-amber-800 dark:text-amber-200"
      >
        {open ? "Hide" : "Show"} {title}
      </button>
      {open ? (
        <ul className="mt-2 grid gap-1 text-xs">
          {samples.map((s, i) => (
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
