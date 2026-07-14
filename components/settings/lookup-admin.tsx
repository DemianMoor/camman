"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpDown,
  CheckCircle2,
  Loader2,
  RefreshCw,
} from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
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

// Targeted (scoped) lookup — client mirrors of lib/telnyx/preview + enqueue shapes.
type GroupLookupPreview = {
  group_id: number;
  group_name: string | null;
  remaining: number;
  already_queued: number;
  to_enqueue: number;
  est_cost_usd: number;
  balance_usd: number | null;
  balance_error: string | null;
  daily_cap: number;
  eta_days: number;
  large_run: boolean;
};

type MatchListPreview = {
  rows_in: number;
  unique_numbers: number;
  valid: number;
  invalid: number;
  matched: number;
  not_found: number;
  already_looked_up: number;
  already_queued: number;
  to_enqueue: number;
  est_cost_usd: number;
  balance_usd: number | null;
  balance_error: string | null;
  daily_cap: number;
  eta_days: number;
  large_run: boolean;
};

type EnqueueResult = {
  batchId: string;
  total: number;
  cacheHits: number;
  enqueued: number;
  estCostUsd: number;
};

type EnqueueMatchedResult = EnqueueResult & {
  matched: number;
  not_found: number;
  already_looked_up: number;
  already_queued: number;
};

// Word an operator types to confirm a large scoped run (> LARGE_RUN_THRESHOLD).
const LARGE_RUN_CONFIRM_WORD = "LOOKUP";
const LINE_TYPE_HINTS = ["mobile", "landline", "voip", "toll_free", "unknown"];
// Bulk CSV rows are POSTed in chunks: one request with the whole file blows Vercel's
// ~4.5MB serverless request-body limit (413) at ~60K+ rows, and the route caps at
// 100K rows. 20K rows/chunk (~1.5MB) stays comfortably under both.
const CSV_UPLOAD_CHUNK = 20_000;

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
      <LookupStatsSection />
      <UploadListSection />
      <SettingsSection />
      <BulkUpdateSection />
      <BatchesSection />
      <TriageQueueSection />
      <UnmappedSection />
    </div>
  );
}

// ===== (0) Lookup stats panel — coverage + suppression per contact group =====

type StatGroup = {
  group_id: number;
  name: string;
  total: number;
  looked_up: number;
  telnyx: number;
  manual: number;
  coverage_pct: number;
  landlines: number;
  opt_outs: number;
  sendable: number;
  remaining: number;
};
type StatSummary = Omit<StatGroup, "group_id" | "name"> & { groups: number };
type LookupStats = {
  data: { summary: StatSummary; groups: StatGroup[] };
  computed_at: string;
  stale: boolean;
};

// A group is flagged "needs a lookup run" when >50% of it has no carrier lookup.
const UNLOOKED_FLAG_RATIO = 0.5;

type SortKey = keyof Omit<StatGroup, "group_id" | "name"> | "name";

function num(n: number): string {
  return n.toLocaleString();
}

function LookupStatsSection() {
  const loadApi = useApiCall<LookupStats>();
  const refreshApi = useApiCall<LookupStats>();
  const groupPreviewApi = useApiCall<GroupLookupPreview>();
  const enqueueGroupApi = useApiCall<EnqueueResult>();
  const { execute } = loadApi;
  const [stats, setStats] = useState<LookupStats | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("total");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [groupPreview, setGroupPreview] = useState<GroupLookupPreview | null>(null);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await execute("/api/telnyx/lookup/group-stats");
      if (!cancelled && r.ok) setStats(r.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [execute]);

  async function handleRefresh() {
    const r = await refreshApi.execute("/api/telnyx/lookup/group-stats/refresh", {
      method: "POST",
    });
    if (!r.ok) {
      // Prior data is preserved server-side; keep showing it, just surface the failure.
      toastApiError(r, "Refresh failed — still showing the last good data");
      return;
    }
    setStats(r.data);
    toast.success("Lookup stats refreshed");
  }

  async function openGroupLookup(groupId: number) {
    setGroupPreview(null);
    setConfirmText("");
    setGroupDialogOpen(true);
    const r = await groupPreviewApi.execute(
      `/api/telnyx/lookup/group-preview?groupId=${groupId}`,
    );
    if (!r.ok) {
      toastApiError(r, "Couldn't load the group preview");
      setGroupDialogOpen(false);
      return;
    }
    setGroupPreview(r.data);
  }

  async function confirmGroupLookup() {
    if (!groupPreview) return;
    const r = await enqueueGroupApi.execute("/api/telnyx/lookup/enqueue-group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: groupPreview.group_id }),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't enqueue lookups");
      return;
    }
    toast.success(
      `Enqueued ${r.data.enqueued.toLocaleString()} number${
        r.data.enqueued === 1 ? "" : "s"
      } for "${groupPreview.group_name ?? "group"}" — the worker drains them at the daily cap`,
    );
    setGroupDialogOpen(false);
    setGroupPreview(null);
    setConfirmText("");
  }

  const groupNeedsHeavyConfirm = groupPreview?.large_run ?? false;
  const groupConfirmReady =
    groupPreview != null &&
    groupPreview.to_enqueue > 0 &&
    (!groupNeedsHeavyConfirm || confirmText === LARGE_RUN_CONFIRM_WORD);

  function toggleSort(k: SortKey) {
    if (k === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      setSortDir(k === "name" ? "asc" : "desc");
    }
  }

  const sortedGroups = useMemo(() => {
    const g = stats?.data.groups ?? [];
    return [...g].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp =
        typeof av === "string" && typeof bv === "string"
          ? av.localeCompare(bv)
          : Number(av) - Number(bv);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [stats, sortKey, sortDir]);

  const computedAt = stats ? new Date(stats.computed_at) : null;
  const isStale = stats?.stale ?? false;
  const s = stats?.data.summary;

  const cols: { key: SortKey; label: string; className?: string }[] = [
    { key: "name", label: "Group", className: "text-left" },
    { key: "total", label: "Total" },
    { key: "looked_up", label: "Looked up" },
    { key: "coverage_pct", label: "Coverage %" },
    { key: "telnyx", label: "Telnyx / Manual" },
    { key: "landlines", label: "Landlines suppressed" },
    { key: "sendable", label: "Sendable" },
    { key: "remaining", label: "Remaining un-looked-up" },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b py-3">
        <div className="flex flex-col">
          <CardTitle className="text-sm font-semibold">
            Lookup coverage by contact group
          </CardTitle>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs">
            {computedAt ? (
              <>
                <span
                  className={cn(
                    "font-medium",
                    isStale ? "text-amber-700" : "text-muted-foreground",
                  )}
                >
                  as of {formatCampaignDateTime(computedAt)}
                </span>
                {isStale ? (
                  <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">
                    <AlertTriangle className="size-3" aria-hidden /> may be stale
                  </span>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground">not computed yet</span>
            )}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshApi.isLoading || loadApi.isLoading}
        >
          {refreshApi.isLoading ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="size-4" aria-hidden />
          )}
          Refresh now
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4 p-5">
        {!stats && loadApi.isLoading ? (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Computing…
          </p>
        ) : !s ? (
          <p className="py-4 text-sm text-muted-foreground">No data.</p>
        ) : (
          <>
            {/* Summary strip — distinct contacts across all active groups */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Metric label="Total contacts" value={num(s.total)} />
              <Metric
                label="Looked up"
                value={`${num(s.looked_up)}`}
                sub={`Telnyx ${num(s.telnyx)} · Manual ${num(s.manual)}`}
              />
              <Metric label="Landlines suppressed" value={num(s.landlines)} />
              <Metric label="Sendable" value={num(s.sendable)} />
              <Metric label="Remaining un-looked-up" value={num(s.remaining)} />
            </div>
            <p className="text-xs text-muted-foreground">
              Summary counts each contact once. A contact in multiple groups is
              counted in each group&apos;s row below.
            </p>

            {/* Per-group sortable table */}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    {cols.map((c) => (
                      <th
                        key={c.key}
                        className={cn(
                          "px-2 py-2 font-medium",
                          c.className ?? "text-right",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => toggleSort(c.key)}
                          className={cn(
                            "inline-flex items-center gap-1 hover:text-foreground",
                            c.className === "text-left" ? "" : "flex-row-reverse",
                          )}
                        >
                          {c.label}
                          <ArrowUpDown
                            className={cn(
                              "size-3",
                              sortKey === c.key
                                ? "text-foreground"
                                : "text-muted-foreground/40",
                            )}
                            aria-hidden
                          />
                        </button>
                      </th>
                    ))}
                    <th className="px-2 py-2" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {sortedGroups.map((g) => {
                    const needsLookup =
                      g.total > 0 && g.remaining / g.total > UNLOOKED_FLAG_RATIO;
                    return (
                      <tr
                        key={g.group_id}
                        className={cn(
                          "border-b",
                          needsLookup ? "bg-amber-50" : "",
                        )}
                      >
                        <td className="px-2 py-2 text-left font-medium">
                          {g.name}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {num(g.total)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {num(g.looked_up)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {g.coverage_pct}%
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                          {num(g.telnyx)} / {num(g.manual)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {num(g.landlines)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {num(g.sendable)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1",
                              needsLookup ? "font-semibold text-amber-800" : "",
                            )}
                          >
                            {needsLookup ? (
                              <AlertTriangle className="size-3.5" aria-hidden />
                            ) : null}
                            {num(g.remaining)}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => openGroupLookup(g.group_id)}
                            disabled={g.remaining === 0 || groupDialogOpen}
                            title={
                              g.remaining === 0
                                ? "Nothing to look up — fully covered"
                                : "Enqueue this group's un-looked-up numbers"
                            }
                          >
                            Look up
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              Highlighted rows are more than 50% un-looked-up — run a carrier
              lookup there before sending. Sendable = eligible contacts minus
              suppressed landlines and opt-outs (the same audience a send targets).
            </p>
          </>
        )}
      </CardContent>

      <AlertDialog open={groupDialogOpen} onOpenChange={setGroupDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Look up{" "}
              {groupPreview ? `"${groupPreview.group_name ?? "group"}"` : "group"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Enqueues this group&apos;s un-looked-up numbers into the existing
              lookup queue. The worker drains them at the daily cap — cached
              numbers are skipped and never re-paid. This doesn&apos;t run
              inline.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {groupPreviewApi.isLoading || !groupPreview ? (
            <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Computing…
            </p>
          ) : (
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Metric label="Un-looked-up" value={num(groupPreview.remaining)} />
                <Metric
                  label="To enqueue"
                  value={num(groupPreview.to_enqueue)}
                  sub={
                    groupPreview.already_queued > 0
                      ? `${num(groupPreview.already_queued)} already queued`
                      : undefined
                  }
                />
                <Metric
                  label="Est. cost"
                  value={usd(groupPreview.est_cost_usd)}
                  sub="provisional"
                />
                <Metric
                  label="Telnyx balance"
                  value={usd(groupPreview.balance_usd)}
                />
                <Metric
                  label="Time to drain"
                  value={`~${num(groupPreview.eta_days)} day${
                    groupPreview.eta_days === 1 ? "" : "s"
                  }`}
                  sub={`at ${num(groupPreview.daily_cap)}/day cap`}
                />
              </div>
              {groupPreview.balance_usd !== null &&
              groupPreview.balance_usd < groupPreview.est_cost_usd ? (
                <p className="text-xs text-destructive">
                  Estimated cost exceeds the available Telnyx balance (estimate is
                  provisional; actual spend shows on the batch Est-vs-Billed line).
                </p>
              ) : null}
              {groupPreview.to_enqueue === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nothing to enqueue — every number here is already looked up or
                  already queued.
                </p>
              ) : null}
              {groupNeedsHeavyConfirm ? (
                <div className="grid gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/20">
                  <Label htmlFor="group-confirm-word" className="text-amber-900 dark:text-amber-200">
                    Large run — {num(groupPreview.to_enqueue)} numbers, ~
                    {num(groupPreview.eta_days)} day
                    {groupPreview.eta_days === 1 ? "" : "s"} to drain at the cap.
                    Type{" "}
                    <span className="font-mono font-semibold">
                      {LARGE_RUN_CONFIRM_WORD}
                    </span>{" "}
                    to confirm.
                  </Label>
                  <Input
                    id="group-confirm-word"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder={LARGE_RUN_CONFIRM_WORD}
                    autoComplete="off"
                  />
                </div>
              ) : null}
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={enqueueGroupApi.isLoading}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmGroupLookup();
              }}
              disabled={!groupConfirmReady || enqueueGroupApi.isLoading}
            >
              {enqueueGroupApi.isLoading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : null}
              {groupPreview && groupPreview.to_enqueue > 0
                ? `Enqueue ${num(groupPreview.to_enqueue)}`
                : "Enqueue"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ===== (a) Upload a list to look up (existing numbers only) =====

function UploadListSection() {
  const previewApi = useApiCall<MatchListPreview>();
  const enqueueApi = useApiCall<EnqueueMatchedResult>();
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<MatchListPreview | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  function handleFile(file: File) {
    setFileName(file.name);
    setPreview(null);
    if (file.name.toLowerCase().endsWith(".csv")) {
      // CSV: pull the phone column (or the first column if none is named).
      Papa.parse<Record<string, string>>(file, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => h.trim().toLowerCase(),
        complete: (parsed) => {
          const fields = parsed.meta.fields ?? [];
          const key =
            fields.find((f) =>
              ["phone", "phone_number", "number", "mobile", "msisdn"].includes(f),
            ) ?? fields[0];
          const out: string[] = [];
          for (const r of parsed.data) {
            const v = (r[key] ?? "").trim();
            if (v) out.push(v);
          }
          setText(out.join("\n"));
        },
        error: () => toast.error("Couldn't parse the CSV"),
      });
    } else {
      // Plain text: one number per line (invalid tokens are reported, not run).
      file
        .text()
        .then((t) => setText(t))
        .catch(() => toast.error("Couldn't read the file"));
    }
  }

  async function handlePreview() {
    setPreview(null);
    const r = await previewApi.execute("/api/telnyx/lookup/match-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phones: text }),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't preview the list");
      return;
    }
    setPreview(r.data);
  }

  async function handleConfirm() {
    const r = await enqueueApi.execute("/api/telnyx/lookup/enqueue-matched", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phones: text }),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't enqueue lookups");
      return;
    }
    const d = r.data;
    toast.success(
      `Enqueued ${d.enqueued.toLocaleString()} number${
        d.enqueued === 1 ? "" : "s"
      }${
        d.not_found > 0
          ? ` · ${d.not_found.toLocaleString()} weren't in the system (skipped, not created)`
          : ""
      }`,
    );
    setConfirmOpen(false);
    setConfirmText("");
    setPreview(null);
    setText("");
    setFileName(null);
  }

  const needsHeavyConfirm = preview?.large_run ?? false;
  const confirmReady =
    !needsHeavyConfirm || confirmText === LARGE_RUN_CONFIRM_WORD;

  return (
    <Card>
      <CardHeader className="border-b py-3">
        <CardTitle className="text-sm font-semibold">
          Look up a list of existing numbers
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 p-5">
        <p className="text-sm text-muted-foreground">
          Paste or upload numbers that <strong>already exist</strong> in the
          system to enqueue carrier lookups for them. Numbers not found are
          reported and skipped — this never creates contacts. Already-looked-up
          numbers are skipped (free). Enqueues into the same worker queue,
          drained at the daily cap.
        </p>

        <div className="grid gap-1.5">
          <Label htmlFor="list-numbers">Numbers</Label>
          <Textarea
            id="list-numbers"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPreview(null);
            }}
            placeholder={"One per line, or comma/semicolon separated\n+12125550100\n+12125550101"}
            className="min-h-28 font-mono text-xs"
            disabled={previewApi.isLoading || enqueueApi.isLoading}
          />
        </div>

        <FileDropZone
          accept=".csv,.txt"
          onFile={handleFile}
          hint="…or click to select / drag a CSV or text file of numbers"
          selectedSummary={fileName ? { name: fileName } : null}
          disabled={previewApi.isLoading || enqueueApi.isLoading}
        />

        <div>
          <Button
            variant="outline"
            onClick={handlePreview}
            disabled={
              text.trim() === "" || previewApi.isLoading || enqueueApi.isLoading
            }
          >
            {previewApi.isLoading ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : null}
            Preview
          </Button>
        </div>

        {preview ? (
          <div className="grid gap-3 rounded-md border p-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric label="Matched existing" value={num(preview.matched)} />
              <Metric
                label="Not found (skipped)"
                value={num(preview.not_found)}
              />
              <Metric
                label="Already looked up"
                value={num(preview.already_looked_up)}
                sub="free"
              />
              <Metric
                label="To enqueue"
                value={num(preview.to_enqueue)}
                sub={
                  preview.already_queued > 0
                    ? `${num(preview.already_queued)} already queued`
                    : undefined
                }
              />
              <Metric
                label="Est. cost"
                value={usd(preview.est_cost_usd)}
                sub="provisional"
              />
              <Metric label="Telnyx balance" value={usd(preview.balance_usd)} />
              <Metric
                label="Time to drain"
                value={`~${num(preview.eta_days)} day${
                  preview.eta_days === 1 ? "" : "s"
                }`}
                sub={`at ${num(preview.daily_cap)}/day cap`}
              />
              <Metric
                label="Invalid / unique"
                value={`${num(preview.invalid)} / ${num(preview.unique_numbers)}`}
              />
            </div>
            {preview.balance_usd !== null &&
            preview.balance_usd < preview.est_cost_usd ? (
              <p className="text-xs text-destructive">
                Estimated cost exceeds the available Telnyx balance (estimate is
                provisional; actual spend shows on the batch Est-vs-Billed line).
              </p>
            ) : null}
            {preview.not_found > 0 ? (
              <p className="text-xs text-muted-foreground">
                {num(preview.not_found)} number
                {preview.not_found === 1 ? "" : "s"} weren&apos;t found in the
                system and will be skipped — no contacts are created.
              </p>
            ) : null}
            <div>
              <Button
                onClick={() => {
                  setConfirmText("");
                  setConfirmOpen(true);
                }}
                disabled={enqueueApi.isLoading || preview.to_enqueue === 0}
              >
                Enqueue {num(preview.to_enqueue)}
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Enqueue {preview ? num(preview.to_enqueue) : 0} lookup
              {preview?.to_enqueue === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Enqueues {preview ? num(preview.to_enqueue) : 0} matched existing
              number{preview?.to_enqueue === 1 ? "" : "s"} at an estimated{" "}
              {usd(preview?.est_cost_usd ?? 0)} (provisional). Cached numbers are
              free.{" "}
              {preview && preview.not_found > 0
                ? `${num(preview.not_found)} not-found number${
                    preview.not_found === 1 ? "" : "s"
                  } will be skipped (not created).`
                : ""}{" "}
              The worker drains at the daily cap.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {needsHeavyConfirm ? (
            <div className="grid gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/20">
              <Label htmlFor="list-confirm-word" className="text-amber-900 dark:text-amber-200">
                Large run — {preview ? num(preview.to_enqueue) : 0} numbers, ~
                {preview ? num(preview.eta_days) : 0} day
                {preview?.eta_days === 1 ? "" : "s"} to drain at the cap. Type{" "}
                <span className="font-mono font-semibold">
                  {LARGE_RUN_CONFIRM_WORD}
                </span>{" "}
                to confirm.
              </Label>
              <Input
                id="list-confirm-word"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={LARGE_RUN_CONFIRM_WORD}
                autoComplete="off"
              />
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={enqueueApi.isLoading}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleConfirm();
              }}
              disabled={!confirmReady || enqueueApi.isLoading}
            >
              {enqueueApi.isLoading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : null}
              Enqueue
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

// ===== (d2) Carrier triage queue (AI + human review) =====

type TriageRow = {
  match_key: string;
  raw_example: string;
  status: string;
  confidence: number | null;
  last_error: string | null;
  contact_count: number;
};

function TriageQueueSection() {
  const listApi = useApiCall<{ data: TriageRow[] }>();
  const assignApi = useApiCall<{
    lookups_updated: number;
    contacts_updated: number;
  }>();
  const { execute } = listApi;
  const [rows, setRows] = useState<TriageRow[]>([]);
  const [tick, setTick] = useState(0);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [assigning, setAssigning] = useState<string | null>(null);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await execute("/api/carrier/triage-queue");
      if (!cancelled && r.ok) setRows(r.data.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [execute, tick]);

  async function handleAssign(row: TriageRow) {
    const bucket = picks[row.match_key];
    if (!bucket) return;
    setAssigning(row.match_key);
    const r = await assignApi.execute("/api/carrier/triage-queue/assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        match_key: row.match_key,
        raw_example: row.raw_example,
        bucket,
      }),
    });
    setAssigning(null);
    if (!r.ok) {
      toastApiError(r, "Couldn't assign mapping");
      return;
    }
    toast.success(
      `Mapped "${row.raw_example}" → ${bucket} (${r.data.lookups_updated.toLocaleString()} lookups, ${r.data.contacts_updated.toLocaleString()} contacts)`,
    );
    refresh();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between border-b py-3">
        <CardTitle className="text-sm font-semibold">
          Carrier triage — needs review
        </CardTitle>
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
          Carrier strings the resolver chain couldn&apos;t bucket, ranked by
          affected contacts. AI triage resolves recognizable names automatically;
          what remains here names no identifiable network — assign it and every
          route-suffix variant is reclassified at once.
        </p>
        {rows.length === 0 ? (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            {listApi.isLoading ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
              </>
            ) : (
              <>
                <CheckCircle2 className="size-4 text-emerald-600" aria-hidden />{" "}
                Nothing awaiting review.
              </>
            )}
          </p>
        ) : (
          <ul className="grid gap-2">
            {rows.map((row) => (
              <li
                key={row.match_key}
                className="flex flex-wrap items-center gap-2 rounded-md border p-2"
              >
                <span className="font-mono text-sm">{row.raw_example}</span>
                <span className="text-xs text-muted-foreground">
                  {row.contact_count.toLocaleString()} contact
                  {row.contact_count === 1 ? "" : "s"}
                </span>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px] font-medium",
                    row.status === "needs_human"
                      ? "bg-amber-100 text-amber-800"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {row.status === "needs_human" ? "AI: unresolved" : "pending AI"}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <Select
                    value={picks[row.match_key] ?? ""}
                    onValueChange={(v) =>
                      setPicks((prev) => ({ ...prev, [row.match_key]: v }))
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
                    onClick={() => handleAssign(row)}
                    disabled={
                      !picks[row.match_key] || assigning === row.match_key
                    }
                  >
                    {assigning === row.match_key ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : null}
                    Assign
                  </Button>
                </div>
              </li>
            ))}
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
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );

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
    if (rows.length === 0 || submitting) return;
    setSubmitting(true);
    setResult(null);
    const agg: CsvUpdateResult = {
      submitted: 0,
      valid: 0,
      invalid: 0,
      written: 0,
      skipped_telnyx: 0,
      contacts_synced: 0,
    };
    setProgress({ done: 0, total: rows.length });
    // POST in chunks so a large file doesn't exceed the 4.5MB body / 100K-row limits.
    // The upsert is idempotent, so a mid-run failure is safe to re-run from the file.
    for (let i = 0; i < rows.length; i += CSV_UPLOAD_CHUNK) {
      const chunk = rows.slice(i, i + CSV_UPLOAD_CHUNK);
      const r = await importApi.execute("/api/telnyx/lookup/csv-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: chunk }),
      });
      if (!r.ok) {
        setProgress(null);
        setSubmitting(false);
        toastApiError(
          r,
          `Couldn't update contacts (stopped after ${agg.submitted.toLocaleString()} of ${rows.length.toLocaleString()} rows — safe to retry)`,
        );
        if (agg.submitted > 0) setResult(agg);
        return;
      }
      agg.submitted += r.data.submitted;
      agg.valid += r.data.valid;
      agg.invalid += r.data.invalid;
      agg.written += r.data.written;
      agg.skipped_telnyx += r.data.skipped_telnyx;
      agg.contacts_synced += r.data.contacts_synced;
      setProgress({ done: Math.min(i + CSV_UPLOAD_CHUNK, rows.length), total: rows.length });
    }
    setProgress(null);
    setSubmitting(false);
    setResult(agg);
    toast.success(
      `Updated ${agg.written.toLocaleString()} lookup${
        agg.written === 1 ? "" : "s"
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
            <div className="flex items-center gap-3">
              <Button onClick={handleSubmit} disabled={submitting}>
                {submitting ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : null}
                Update {rows.length.toLocaleString()} contacts
              </Button>
              {progress ? (
                <span className="text-xs text-muted-foreground tabular-nums">
                  Uploading {progress.done.toLocaleString()} /{" "}
                  {progress.total.toLocaleString()} rows…
                </span>
              ) : null}
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

function Metric({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-md border bg-background p-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {sub ? (
        <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
          {sub}
        </div>
      ) : null}
    </div>
  );
}
