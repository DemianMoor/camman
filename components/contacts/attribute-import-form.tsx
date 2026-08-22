"use client";

import { useEffect, useState } from "react";
import Papa from "papaparse";
import { Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { FileDropZone } from "@/components/file-drop-zone";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ATTRIBUTE_FIELDS } from "@/lib/contact-attributes";
import { useApiCall } from "@/lib/hooks/use-api-call";

// Column → field mapping step for attribute CSV imports (Drip P1 1c).
//
// Modelled on components/campaigns/results-import-form.tsx, which does the same
// job for campaign-result CSVs: parse headers client-side, let the operator map
// each column to a field, and save the mapping as a reusable template.
//
// ⚠️ It IMPORTS onto existing contacts and never creates one — a mis-mapped
// column can therefore mangle attributes but can never grow the audience.
// The preview always runs before the commit button becomes available, so the
// operator sees `matched` / `unmatched` / values-ignored before anything writes.

const NONE = "__none__";
const PHONE = "phone";

interface Mapping {
  id: number;
  name: string;
  is_default: boolean;
  mapping: Record<string, string>;
}

interface ImportResult {
  dry_run: boolean;
  total_rows: number;
  matched: number;
  unmatched: number;
  invalid_phone: number;
  normalized_out: number;
  written: number;
  issues: { row: number; reason: string }[];
}

export function AttributeImportForm({ onDone }: { onDone?: () => void }) {
  const listApi = useApiCall<{ data: Mapping[] }>();
  const saveApi = useApiCall<Mapping>();
  const runApi = useApiCall<ImportResult>();

  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string | null>[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [templates, setTemplates] = useState<Mapping[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [preview, setPreview] = useState<ImportResult | null>(null);

  // Async IIFE inside the effect rather than a useCallback the effect invokes:
  // the setState then lands in an await continuation, which is the shape the
  // rest of the codebase uses (see components/campaigns/campaign-form-state.ts)
  // and what react-hooks/set-state-in-effect is asking for.
  const [templatesTick, setTemplatesTick] = useState(0);
  const reloadTemplates = () => setTemplatesTick((n) => n + 1);

  useEffect(() => {
    (async () => {
      const r = await listApi.execute("/api/contact-attribute-mappings");
      if (r.ok) setTemplates(r.data.data);
    })();
  }, [listApi.execute, templatesTick]);

  const onFile = (file: File) => {
    setPreview(null);
    setParseError(null);
    setFileName(file.name);
    Papa.parse<Record<string, string | null>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const hs = (res.meta.fields ?? []).filter((h) => h && h.trim().length > 0);
        if (hs.length === 0) {
          setParseError("No column headers found — the first row must name the columns.");
          return;
        }
        setHeaders(hs);
        setRows(res.data);
        // Auto-apply the default template when its columns match this file, so
        // the common case (same partner, same export) needs no clicks. A
        // template whose columns are absent is NOT applied — silently mapping
        // nothing would look like the template failed to load.
        const def = templates.find((t) => t.is_default);
        if (def && Object.keys(def.mapping).every((c) => hs.includes(c))) {
          setMap(def.mapping);
          toast.success(`Applied mapping "${def.name}"`);
        } else {
          // Best-effort header guess; the operator confirms everything anyway.
          const guess: Record<string, string> = {};
          for (const h of hs) {
            const k = h.trim().toLowerCase().replace(/[^a-z]/g, "");
            if (["phone", "phonenumber", "mobile", "mobilenumber", "cell"].includes(k)) guess[h] = PHONE;
            else {
              const f = ATTRIBUTE_FIELDS.find(
                (a) => a.field.replace(/_/g, "") === k || a.label.toLowerCase().replace(/[^a-z]/g, "") === k,
              );
              if (f) guess[h] = f.field;
            }
          }
          setMap(guess);
        }
      },
      error: (err) => setParseError(err.message),
    });
  };

  const applyTemplate = (t: Mapping) => {
    const missing = Object.keys(t.mapping).filter((c) => !headers.includes(c));
    setMap(t.mapping);
    if (missing.length > 0) {
      // Named explicitly: a partially-applied mapping that silently drops
      // columns is how an import quietly writes half the fields.
      toast.warning(`"${t.name}" applied — ${missing.length} column(s) not in this file: ${missing.slice(0, 3).join(", ")}`);
    } else {
      toast.success(`Applied "${t.name}"`);
    }
  };

  const hasPhone = Object.values(map).includes(PHONE);
  const fieldCount = Object.values(map).filter((v) => v !== PHONE && v !== NONE).length;
  const cleanMap = Object.fromEntries(Object.entries(map).filter(([, v]) => v && v !== NONE));

  const run = async (dryRun: boolean) => {
    const r = await runApi.execute("/api/contacts/import-attributes", {
      method: "POST",
      body: JSON.stringify({ dry_run: dryRun, mapping: cleanMap, rows, source: "csv_upload" }),
    });
    if (!r.ok) {
      toast.error(r.error ?? "Import failed");
      return;
    }
    if (dryRun) {
      setPreview(r.data);
    } else {
      toast.success(`Updated attributes on ${r.data.written.toLocaleString()} contact(s)`);
      setPreview(null);
      setHeaders([]);
      setRows([]);
      setFileName(null);
      setMap({});
      onDone?.();
    }
  };

  const saveTemplate = async () => {
    if (!templateName.trim()) return;
    const r = await saveApi.execute("/api/contact-attribute-mappings", {
      method: "POST",
      body: JSON.stringify({ name: templateName.trim(), mapping: cleanMap }),
    });
    if (r.ok) {
      toast.success(`Saved mapping "${templateName.trim()}"`);
      setTemplateName("");
      reloadTemplates();
    } else {
      toast.error(r.error ?? "Could not save the mapping");
    }
  };

  const removeTemplate = async (t: Mapping) => {
    const r = await saveApi.execute(`/api/contact-attribute-mappings/${t.id}`, { method: "DELETE" });
    if (r.ok) {
      toast.success(`Deleted "${t.name}"`);
      reloadTemplates();
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="text-muted-foreground mb-3 text-sm">
          Updates attributes on contacts that already exist. Rows whose phone isn&apos;t in your
          contacts are reported, never created.
        </p>
        <FileDropZone
          accept=".csv,text/csv"
          onFile={onFile}
          selectedSummary={
            fileName ? { name: fileName, meta: `${rows.length.toLocaleString()} rows` } : null
          }
        />
        {parseError && <p className="text-destructive mt-2 text-sm">{parseError}</p>}
      </div>

      {templates.length > 0 && headers.length > 0 && (
        <div className="space-y-2">
          <Label>Saved mappings</Label>
          <div className="flex flex-wrap gap-2">
            {templates.map((t) => (
              <span key={t.id} className="inline-flex items-center gap-1">
                <Button type="button" variant="outline" size="sm" onClick={() => applyTemplate(t)}>
                  {t.name}
                  {t.is_default && <span className="text-muted-foreground ml-1 text-xs">(default)</span>}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${t.name}`}
                  onClick={() => void removeTemplate(t)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </span>
            ))}
          </div>
        </div>
      )}

      {headers.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <Label>
              Map columns
              <span aria-hidden className="text-destructive ml-0.5">*</span>
            </Label>
            <span className="text-muted-foreground text-xs">
              {rows.length.toLocaleString()} row(s) · {fieldCount} field(s) mapped
            </span>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {headers.map((h) => (
              <div key={h} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={h}>
                  {h}
                </span>
                <Select
                  value={map[h] ?? NONE}
                  onValueChange={(v) => setMap((m) => ({ ...m, [h]: v }))}
                >
                  <SelectTrigger className="w-[190px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>— ignore —</SelectItem>
                    <SelectItem value={PHONE}>Phone (identifies contact)</SelectItem>
                    {ATTRIBUTE_FIELDS.map((f) => (
                      <SelectItem key={f.field} value={f.field}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>

          {!hasPhone && (
            <p className="text-destructive text-sm">
              Map one column to <strong>Phone</strong> — it&apos;s what identifies the contact.
            </p>
          )}

          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1">
              <Label htmlFor="tplname" className="text-xs">
                Save this mapping as
              </Label>
              <Input
                id="tplname"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="e.g. Partner Alpha export"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={!templateName.trim() || !hasPhone || fieldCount === 0 || saveApi.isLoading}
              onClick={() => void saveTemplate()}
            >
              <Save className="mr-1 size-4" /> Save mapping
            </Button>
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={!hasPhone || fieldCount === 0 || runApi.isLoading}
              onClick={() => void run(true)}
            >
              {runApi.isLoading ? "Checking…" : "Preview"}
            </Button>
            {/* Commit is gated on a preview having run: the operator must see
                matched/unmatched before anything is written. */}
            <Button
              type="button"
              disabled={!preview || runApi.isLoading || preview.matched === 0}
              onClick={() => void run(false)}
            >
              {preview ? `Import ${preview.matched.toLocaleString()} contact(s)` : "Import"}
            </Button>
          </div>
        </div>
      )}

      {preview && (
        <div className="bg-muted/40 space-y-2 rounded-md border p-3 text-sm">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div>
              <div className="text-muted-foreground text-xs">Rows</div>
              <div>{preview.total_rows.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Will update</div>
              <div className="font-medium">{preview.matched.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Not in contacts</div>
              <div>{preview.unmatched.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Unreadable phone</div>
              <div>{preview.invalid_phone.toLocaleString()}</div>
            </div>
          </div>
          {preview.normalized_out > 0 && (
            <p className="text-amber-700 dark:text-amber-500">
              {preview.normalized_out.toLocaleString()} value(s) weren&apos;t recognized and will be
              ignored — check the samples below before importing.
            </p>
          )}
          {preview.issues.length > 0 && (
            <ul className="text-muted-foreground max-h-40 space-y-0.5 overflow-auto text-xs">
              {preview.issues.map((it, i) => (
                <li key={i}>
                  row {it.row}: {it.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
