"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import Papa from "papaparse";
import { toast } from "sonner";

import { FileDropZone } from "@/components/file-drop-zone";
import { useAuth } from "@/components/protected/auth-context";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api/toast-error";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";
// The six assignable carrier buckets. ASSIGNABLE_BUCKETS lives in a
// server-only module (lib/telnyx/assign-mapping), so the client uses the
// identical client-safe list from the campaigns validators.
import { CAMPAIGN_CARRIER_FILTER_VALUES } from "@/lib/validators/campaigns";
import { cn } from "@/lib/utils";

// ===== Types =====

type BackfillPreview = {
  distinct_phones_needing: number;
  contact_count: number;
  archived_excluded: number;
  sample_limit: number | null;
  to_run: number;
  est_cost_usd: number;
  balance_usd: number | null;
  daily_cap: number;
  eta_days: number;
};

type BackfillRunResult = {
  batchId: string;
  total: number;
  cacheHits: number;
  enqueued: number;
  estCostUsd: number;
};

type LookupSettings = {
  lookup_paused: boolean;
  lookup_daily_cap: number;
  lookup_rate_base: string;
  lookup_rate_mobile: string;
  lookup_concurrency_rps: number;
};

type LookupBatch = {
  id: string;
  trigger: string;
  total_numbers: number;
  cache_hits: number;
  processed: number;
  failed: number;
  est_cost_usd: string | null;
  actual_cost_usd: string | null;
  balance_before_usd: string | null;
  balance_after_usd: string | null;
  status: string;
  created_at: string;
};

type UnmappedRow = { carrier_raw: string | null; count: number };

type CsvUpdateResult = {
  submitted: number;
  valid: number;
  invalid: number;
  written: number;
  skipped_telnyx: number;
  contacts_synced: number;
};

const TYPE_TO_CONFIRM_THRESHOLD = 100_000;
const CONFIRM_WORD = "BACKFILL";
const LINE_TYPE_HINTS = ["mobile", "landline", "voip", "toll_free", "unknown"];

function usd(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const v = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(v)) return "—";
  return `$${v.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

// ===== Top-level =====

export function LookupAdmin() {
  const { can } = useAuth();
  if (!can("lookup.admin")) {
    return (
      <Card>
        <CardContent className="p-5 text-sm text-muted-foreground">
          You need the manager role or higher to manage carrier lookups.
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-6">
      <BackfillSection />
      <SettingsSection />
      <BulkUpdateSection />
      <BatchesSection />
      <UnmappedSection />
    </div>
  );
}

// ===== (a) Backfill =====

function BackfillSection() {
  const previewApi = useApiCall<BackfillPreview>();
  const runApi = useApiCall<BackfillRunResult>();
  const [sampleLimit, setSampleLimit] = useState("");
  const [preview, setPreview] = useState<BackfillPreview | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const sampleLimitValue = sampleLimit.trim() === "" ? null : Number(sampleLimit);

  async function handlePreview() {
    setPreview(null);
    const r = await previewApi.execute("/api/telnyx/lookup/backfill/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sampleLimit: sampleLimitValue }),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't preview backfill");
      return;
    }
    setPreview(r.data);
  }

  const needsTypeToConfirm =
    preview !== null && preview.to_run > TYPE_TO_CONFIRM_THRESHOLD;
  const confirmReady = !needsTypeToConfirm || confirmText === CONFIRM_WORD;

  async function handleRun() {
    const r = await runApi.execute("/api/telnyx/lookup/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sampleLimit: sampleLimitValue, confirm: true }),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't start backfill");
      return;
    }
    toast.success(
      `Backfill queued — ${r.data.enqueued.toLocaleString()} number${
        r.data.enqueued === 1 ? "" : "s"
      } enqueued`,
    );
    setConfirmOpen(false);
    setConfirmText("");
    setPreview(null);
  }

  return (
    <Card>
      <CardHeader className="border-b py-3">
        <CardTitle className="text-sm font-semibold">Backfill</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 p-5">
        <p className="text-sm text-muted-foreground">
          Look up carrier + line type for existing contacts that have never
          been enriched. Preview the cost first; the worker drains the queue at
          the configured daily cap.
        </p>
        <div className="grid gap-1.5 sm:max-w-xs">
          <Label htmlFor="sample-limit">Sample limit</Label>
          <Input
            id="sample-limit"
            type="number"
            min={1}
            step={1}
            placeholder="Blank = full backfill"
            value={sampleLimit}
            onChange={(e) => setSampleLimit(e.target.value)}
            disabled={previewApi.isLoading || runApi.isLoading}
          />
          <p className="text-xs text-muted-foreground">
            Cap how many numbers to enqueue. Leave blank to enqueue everything
            that needs a lookup.
          </p>
        </div>
        <div>
          <Button
            variant="outline"
            onClick={handlePreview}
            disabled={previewApi.isLoading || runApi.isLoading}
          >
            {previewApi.isLoading ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : null}
            Preview
          </Button>
        </div>

        {preview ? (
          <div className="grid gap-3 rounded-md border p-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Metric
                label="Needs lookup"
                value={preview.distinct_phones_needing.toLocaleString()}
              />
              <Metric
                label="Contacts"
                value={preview.contact_count.toLocaleString()}
              />
              <Metric
                label="Archived excluded"
                value={preview.archived_excluded.toLocaleString()}
              />
              <Metric label="To run" value={preview.to_run.toLocaleString()} />
              <Metric label="Est. cost" value={usd(preview.est_cost_usd)} />
              <Metric label="Balance" value={usd(preview.balance_usd)} />
            </div>
            <p className="text-xs text-muted-foreground">
              At {preview.daily_cap.toLocaleString()}/day: ~
              {preview.eta_days.toLocaleString()} day
              {preview.eta_days === 1 ? "" : "s"} to finish.
            </p>
            {preview.balance_usd !== null &&
            preview.balance_usd < preview.est_cost_usd ? (
              <p className="text-xs text-destructive">
                Estimated cost exceeds the available Telnyx balance.
              </p>
            ) : null}
            <div>
              <Button
                onClick={() => {
                  setConfirmText("");
                  setConfirmOpen(true);
                }}
                disabled={runApi.isLoading || preview.to_run === 0}
              >
                Run backfill
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Run backfill for {preview?.to_run.toLocaleString() ?? 0} numbers?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This enqueues {preview?.to_run.toLocaleString() ?? 0} Telnyx
              lookups at an estimated cost of {usd(preview?.est_cost_usd ?? 0)}.
              Cached numbers are free. The worker drains at the daily cap.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {needsTypeToConfirm ? (
            <div className="grid gap-1.5">
              <Label htmlFor="confirm-word">
                This is a large backfill. Type{" "}
                <span className="font-mono font-semibold">{CONFIRM_WORD}</span>{" "}
                to confirm.
              </Label>
              <Input
                id="confirm-word"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={CONFIRM_WORD}
                autoComplete="off"
              />
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={runApi.isLoading}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleRun();
              }}
              disabled={!confirmReady || runApi.isLoading}
            >
              {runApi.isLoading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : null}
              Run backfill
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ===== (b) Settings =====

function SettingsSection() {
  const getApi = useApiCall<LookupSettings>();
  const patchApi = useApiCall<LookupSettings>();
  const { execute: getExec } = getApi;
  const [form, setForm] = useState<LookupSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await getExec("/api/telnyx/lookup/settings");
      if (!cancelled && r.ok) setForm(r.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [getExec]);

  function update<K extends keyof LookupSettings>(
    key: K,
    value: LookupSettings[K],
  ) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function handleSave() {
    if (!form) return;
    const r = await patchApi.execute("/api/telnyx/lookup/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lookup_paused: form.lookup_paused,
        lookup_daily_cap: Number(form.lookup_daily_cap),
        lookup_rate_base: String(form.lookup_rate_base),
        lookup_rate_mobile: String(form.lookup_rate_mobile),
        lookup_concurrency_rps: Number(form.lookup_concurrency_rps),
      }),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't save settings");
      return;
    }
    setForm(r.data);
    toast.success("Lookup settings saved");
  }

  return (
    <Card>
      <CardHeader className="border-b py-3">
        <CardTitle className="text-sm font-semibold">Settings</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 p-5">
        {!form ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
          </p>
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div className="grid gap-0.5">
                <span className="text-sm font-medium">Pause lookups</span>
                <span className="text-xs text-muted-foreground">
                  Stops the worker from draining the queue. New numbers still
                  enqueue.
                </span>
              </div>
              <Switch
                checked={form.lookup_paused}
                onCheckedChange={(v) => update("lookup_paused", v)}
                disabled={patchApi.isLoading}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="daily-cap">Daily cap</Label>
                <Input
                  id="daily-cap"
                  type="number"
                  min={1}
                  step={1}
                  value={form.lookup_daily_cap}
                  onChange={(e) =>
                    update("lookup_daily_cap", Number(e.target.value))
                  }
                  disabled={patchApi.isLoading}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="concurrency">Concurrency (rps)</Label>
                <Input
                  id="concurrency"
                  type="number"
                  min={1}
                  step={1}
                  value={form.lookup_concurrency_rps}
                  onChange={(e) =>
                    update("lookup_concurrency_rps", Number(e.target.value))
                  }
                  disabled={patchApi.isLoading}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="rate-base">Rate — base ($/lookup)</Label>
                <Input
                  id="rate-base"
                  value={form.lookup_rate_base}
                  onChange={(e) => update("lookup_rate_base", e.target.value)}
                  disabled={patchApi.isLoading}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="rate-mobile">Rate — mobile ($/lookup)</Label>
                <Input
                  id="rate-mobile"
                  value={form.lookup_rate_mobile}
                  onChange={(e) => update("lookup_rate_mobile", e.target.value)}
                  disabled={patchApi.isLoading}
                />
              </div>
            </div>
            <div>
              <Button onClick={handleSave} disabled={patchApi.isLoading}>
                {patchApi.isLoading ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : null}
                Save settings
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ===== (c) Batches =====

function BatchesSection() {
  const listApi = useApiCall<{ data: LookupBatch[] }>();
  const { execute } = listApi;
  const [batches, setBatches] = useState<LookupBatch[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await execute("/api/telnyx/lookup/batches");
      if (!cancelled && r.ok) setBatches(r.data.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [execute, tick]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between border-b py-3">
        <CardTitle className="text-sm font-semibold">Recent batches</CardTitle>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setTick((n) => n + 1)}
          disabled={listApi.isLoading}
        >
          {listApi.isLoading ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : null}
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {batches.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">
            {listApi.isLoading ? "Loading…" : "No lookup batches yet."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Created</th>
                  <th className="px-3 py-2 font-medium">Trigger</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2 text-right font-medium">Cache</th>
                  <th className="px-3 py-2 text-right font-medium">Done</th>
                  <th className="px-3 py-2 text-right font-medium">Failed</th>
                  <th className="px-3 py-2 text-right font-medium">Est.</th>
                  <th className="px-3 py-2 text-right font-medium">Actual</th>
                  <th className="px-3 py-2 text-right font-medium">
                    Bal. before
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    Bal. after
                  </th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {formatCampaignDateTime(b.created_at)}
                    </td>
                    <td className="px-3 py-2">{b.trigger}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center rounded-md border bg-muted px-1.5 py-0.5 text-xs">
                        {b.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {b.total_numbers.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {b.cache_hits.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {b.processed.toLocaleString()}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2 text-right tabular-nums",
                        b.failed > 0 && "text-destructive",
                      )}
                    >
                      {b.failed.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {usd(b.est_cost_usd)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {usd(b.actual_cost_usd)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {usd(b.balance_before_usd)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {usd(b.balance_after_usd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ===== (d) Unmapped queue =====

function UnmappedSection() {
  const listApi = useApiCall<{ data: UnmappedRow[] }>();
  const assignApi = useApiCall<{
    lookups_updated: number;
    contacts_updated: number;
  }>();
  const { execute } = listApi;
  const [rows, setRows] = useState<UnmappedRow[]>([]);
  const [tick, setTick] = useState(0);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [assigning, setAssigning] = useState<string | null>(null);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await execute("/api/telnyx/lookup/unmapped");
      if (!cancelled && r.ok) setRows(r.data.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [execute, tick]);

  async function handleAssign(rawName: string) {
    const bucket = picks[rawName];
    if (!bucket) return;
    setAssigning(rawName);
    const r = await assignApi.execute("/api/telnyx/lookup/assign-mapping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw_name: rawName, bucket }),
    });
    setAssigning(null);
    if (!r.ok) {
      toastApiError(r, "Couldn't assign mapping");
      return;
    }
    toast.success(
      `Mapped "${rawName}" → ${bucket} (${r.data.lookups_updated.toLocaleString()} lookups, ${r.data.contacts_updated.toLocaleString()} contacts)`,
    );
    refresh();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between border-b py-3">
        <CardTitle className="text-sm font-semibold">Unmapped carriers</CardTitle>
        <Button
          variant="ghost"
          size="sm"
          onClick={refresh}
          disabled={listApi.isLoading}
        >
          {listApi.isLoading ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : null}
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="grid gap-2 p-5">
        <p className="text-sm text-muted-foreground">
          Raw carrier strings Telnyx returned that don&apos;t map to a known
          bucket. Assign each to a bucket — it retroactively reclassifies every
          affected lookup and contact.
        </p>
        {rows.length === 0 ? (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            {listApi.isLoading ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
              </>
            ) : (
              <>
                <CheckCircle2
                  className="size-4 text-emerald-600"
                  aria-hidden
                />{" "}
                Nothing unmapped. All carriers are classified.
              </>
            )}
          </p>
        ) : (
          <ul className="grid gap-2">
            {rows.map((row) => {
              const key = row.carrier_raw ?? "(null)";
              return (
                <li
                  key={key}
                  className="flex flex-wrap items-center gap-2 rounded-md border p-2"
                >
                  <span className="font-mono text-sm">
                    {row.carrier_raw ?? "(null)"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {row.count.toLocaleString()} lookup
                    {row.count === 1 ? "" : "s"}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <Select
                      value={picks[key] ?? ""}
                      onValueChange={(v) =>
                        setPicks((prev) => ({ ...prev, [key]: v }))
                      }
                    >
                      <SelectTrigger className="h-8 w-[150px]">
                        <SelectValue placeholder="Pick bucket" />
                      </SelectTrigger>
                      <SelectContent>
                        {CAMPAIGN_CARRIER_FILTER_VALUES.map((b) => (
                          <SelectItem key={b} value={b}>
                            {b}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      onClick={() => handleAssign(key)}
                      disabled={!picks[key] || assigning === key}
                    >
                      {assigning === key ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden />
                      ) : null}
                      Assign
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ===== (e) Bulk update existing contacts from CSV =====

type ParsedCsvRow = { phone: string; line_type?: string; carrier?: string };

function BulkUpdateSection() {
  const importApi = useApiCall<CsvUpdateResult>();
  const [rows, setRows] = useState<ParsedCsvRow[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<CsvUpdateResult | null>(null);

  function handleFile(file: File) {
    setParseError(null);
    setRows([]);
    setResult(null);
    setFileName(file.name);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase(),
      complete: (parsed) => {
        const fields = parsed.meta.fields ?? [];
        const phoneKey = fields.find((f) =>
          ["phone", "phone_number", "number"].includes(f),
        );
        if (!phoneKey) {
          setParseError(
            "No phone column found. Expected a header named phone, phone_number, or number.",
          );
          return;
        }
        const ltKey = fields.find((f) => f === "line_type");
        const carrierKey = fields.find((f) => f === "carrier");
        const out: ParsedCsvRow[] = [];
        for (const r of parsed.data) {
          const phone = (r[phoneKey] ?? "").trim();
          if (!phone) continue;
          out.push({
            phone,
            line_type: ltKey ? (r[ltKey] ?? "").trim() || undefined : undefined,
            carrier: carrierKey
              ? (r[carrierKey] ?? "").trim() || undefined
              : undefined,
          });
        }
        if (out.length === 0) {
          setParseError("No rows with a phone number found.");
          return;
        }
        setRows(out);
      },
      error: (err) => setParseError(err.message || "Couldn't parse the file."),
    });
  }

  async function handleSubmit() {
    if (rows.length === 0) return;
    const r = await importApi.execute("/api/telnyx/lookup/csv-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't update contacts");
      return;
    }
    setResult(r.data);
    toast.success(
      `Updated ${r.data.written.toLocaleString()} lookup${
        r.data.written === 1 ? "" : "s"
      }`,
    );
  }

  const withLineType = rows.filter((r) => r.line_type).length;
  const withCarrier = rows.filter((r) => r.carrier).length;

  return (
    <Card>
      <CardHeader className="border-b py-3">
        <CardTitle className="text-sm font-semibold">
          Bulk-update from CSV
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 p-5">
        <p className="text-sm text-muted-foreground">
          Update carrier + line type for existing contacts from an external CSV
          (columns <code>phone</code>, <code>line_type</code>,{" "}
          <code>carrier</code>). Makes no Telnyx calls and never overwrites a
          Telnyx-sourced lookup. Allowed line types:{" "}
          {LINE_TYPE_HINTS.map((t) => (
            <code key={t} className="mx-0.5">
              {t}
            </code>
          ))}
          .
        </p>

        <FileDropZone
          accept=".csv,.txt"
          onFile={handleFile}
          hint="Click to select or drag a CSV with phone, line_type, carrier columns"
          selectedSummary={
            fileName && rows.length > 0
              ? { name: fileName, meta: `${rows.length} rows` }
              : null
          }
          disabled={importApi.isLoading}
        />
        {parseError ? (
          <p className="text-sm text-destructive">{parseError}</p>
        ) : null}

        {rows.length > 0 && !result ? (
          <div className="grid gap-3 rounded-md border p-4">
            <div className="grid grid-cols-3 gap-2">
              <Metric label="Rows" value={rows.length.toLocaleString()} />
              <Metric
                label="With line type"
                value={withLineType.toLocaleString()}
              />
              <Metric
                label="With carrier"
                value={withCarrier.toLocaleString()}
              />
            </div>
            <div>
              <Button onClick={handleSubmit} disabled={importApi.isLoading}>
                {importApi.isLoading ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : null}
                Update {rows.length.toLocaleString()} contacts
              </Button>
            </div>
          </div>
        ) : null}

        {result ? (
          <div className="grid gap-3 rounded-md border border-emerald-200 bg-emerald-50/40 p-4 dark:border-emerald-900 dark:bg-emerald-950/20">
            <div className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />
              Update complete
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Metric label="Submitted" value={result.submitted.toLocaleString()} />
              <Metric label="Valid" value={result.valid.toLocaleString()} />
              <Metric label="Invalid" value={result.invalid.toLocaleString()} />
              <Metric label="Written" value={result.written.toLocaleString()} />
              <Metric
                label="Skipped (Telnyx)"
                value={result.skipped_telnyx.toLocaleString()}
              />
              <Metric
                label="Contacts synced"
                value={result.contacts_synced.toLocaleString()}
              />
            </div>
            <div>
              <Button
                variant="outline"
                onClick={() => {
                  setRows([]);
                  setFileName(null);
                  setResult(null);
                }}
              >
                Upload another
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ===== Shared =====

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background p-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
