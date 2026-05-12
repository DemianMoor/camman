"use client";

import { useRef, useState } from "react";
import { CheckCircle2, FileUp, Loader2, Upload } from "lucide-react";
import Papa from "papaparse";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { cn } from "@/lib/utils";

export type UploadResultSummary = {
  submitted: number;
  valid: number;
  invalid: number;
  duplicates_in_input: number;
  duplicates_in_db: number;
  inserted: number;
  invalid_samples: { input: string; error: string }[];
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
}: PhoneUploadFormProps) {
  const uploadApi = useApiCall<UploadResultSummary>();
  const [pasteValue, setPasteValue] = useState("");
  const [csvLines, setCsvLines] = useState<string[]>([]);
  const [csvSourceName, setCsvSourceName] = useState<string | null>(null);
  const [csvPreview, setCsvPreview] = useState<string[]>([]);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"paste" | "csv">("paste");
  const [result, setResult] = useState<UploadResultSummary | null>(null);
  const [showInvalid, setShowInvalid] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setPasteValue("");
    setCsvLines([]);
    setCsvSourceName(null);
    setCsvPreview([]);
    setCsvError(null);
    setResult(null);
    setShowInvalid(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
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

  async function handleSubmit() {
    setResult(null);
    const phones =
      activeTab === "paste" ? pasteValue.trim() : csvLines.join("\n");

    if (!phones) return;

    if (phones.length > MAX_PAYLOAD_BYTES) {
      setCsvError(
        `Payload too large (${(phones.length / 1024 / 1024).toFixed(1)}MB). Max 5MB.`,
      );
      return;
    }

    const result = await uploadApi.execute(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phones, ...(additionalFields ?? {}) }),
    });

    if (!result.ok) {
      toastApiError(result, "Upload failed");
      return;
    }
    setResult(result.data);
    onSuccess?.(result.data);
  }

  const canSubmit =
    !uploadApi.isLoading &&
    ((activeTab === "paste" && pasteValue.trim().length > 0) ||
      (activeTab === "csv" && csvLines.length > 0));

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

  // === Input screen ===
  return (
    <div className="grid gap-4">
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
          <Label htmlFor="phones-paste">Phone numbers</Label>
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
            <Label htmlFor="phones-csv">CSV / TXT file</Label>
            <div className="flex items-center gap-2">
              <Input
                id="phones-csv"
                ref={fileInputRef}
                type="file"
                accept=".csv,.txt"
                disabled={uploadApi.isLoading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileSelect(file);
                }}
                className="cursor-pointer file:cursor-pointer"
              />
            </div>
            {csvError ? (
              <p className="text-sm text-destructive">{csvError}</p>
            ) : null}
            {csvSourceName && !csvError && csvLines.length > 0 ? (
              <div className="rounded-md border bg-muted/40 p-3 text-sm">
                <div className="flex items-center gap-2">
                  <FileUp className="size-4" aria-hidden />
                  <span className="font-medium">{csvSourceName}</span>
                  <span className="text-muted-foreground">
                    — {csvLines.length} {csvLines.length === 1 ? "row" : "rows"}
                  </span>
                </div>
                <div className="mt-2 grid gap-0.5 font-mono text-xs text-muted-foreground">
                  {csvPreview.map((p, i) => (
                    <div key={i}>{p}</div>
                  ))}
                  {csvLines.length > PREVIEW_COUNT ? (
                    <div className="italic">
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

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={uploadApi.isLoading}
        >
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={!canSubmit}>
          {uploadApi.isLoading ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Uploading…
            </>
          ) : (
            <>
              <Upload className="size-4" aria-hidden />
              {submitLabel}
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
