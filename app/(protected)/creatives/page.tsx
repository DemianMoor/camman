"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import {
  ArchiveRestore,
  Archive as ArchiveIcon,
  Check,
  Copy,
  Copy as DuplicateIcon,
  ListChecks,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  ScanSearch,
} from "lucide-react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import {
  BulkCreativeForm,
  type BulkCreativeFormSubmit,
} from "@/components/creatives/bulk-creative-form";
import {
  BulkEditForm,
  type BulkEditPayload,
} from "@/components/creatives/bulk-edit-form";
import {
  CreativeForm,
  type CreativeFormValues,
} from "@/components/creatives/creative-form";
import { DataTable } from "@/components/data-table";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectPicker } from "@/components/multi-select-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api/toast-error";
import { calculateSmsSegments } from "@/lib/creative-helpers";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { cn } from "@/lib/utils";
import {
  FUNNEL_STAGE_VALUES,
  QUALITY_VALUES,
  SEQUENCE_PLACEMENT_VALUES,
  type CreativeFunnelStage,
  type CreativeQuality,
  type CreativeSequencePlacement,
} from "@/lib/validators/creatives";

type Info = {
  id: number;
  name: string;
  color: string | null;
  avatar_url: string | null;
};
type Status = "active" | "archived";

type Creative = {
  id: number;
  creative_id: string | null;
  slug: string;
  org_id: string;
  text: string;
  quality: CreativeQuality;
  sequence_placement: CreativeSequencePlacement;
  funnel_stage: CreativeFunnelStage;
  applies_to_all_offers: boolean;
  status: Status;
  archived_at: string | null;
  created_at: string;
  offers: Info[];
  // 30-day performance metrics. Ratios are null when their denominator
  // (delivered for CTR; clean clicks for the rest) is 0.
  metrics: {
    delivered: number;
    clean_clicks: number;
    checkouts: number;
    sales: number;
    payout: number;
    ctr: number | null;
    checkout_rate: number | null;
    sales_cr: number | null;
    epc: number | null;
  };
  // Spam scoring fields. spam_score is 0-100 (or null when unscored).
  // spam_label is the binary verdict mirrored from the cache; the list
  // endpoint also returns the 3-bucket cache label here for older rows.
  // spam_verdict is derived from score (> 50 ⇒ spam).
  spam_score: number | null;
  spam_label: "ham" | "suspicious" | "spam" | null;
  spam_verdict: "spam" | "not_spam" | null;
  spam_text_hash: string | null;
  spam_scored_at: string | null;
  spam_model_id: string | null;
  spam_score_error: string | null;
};

type ListResponse = { data: Creative[]; totalCount: number };
type OfferInfo = {
  id: number;
  name: string;
  color: string | null;
  status: string;
};
type OfferListResponse = { data: OfferInfo[] };

type Filters = {
  search: string;
  offer_id: number | null;
  qualities: CreativeQuality[];
  sequences: CreativeSequencePlacement[];
  funnelStages: CreativeFunnelStage[];
  showArchived: boolean;
  page: number;
  pageSize: number;
  sortBy: string;
  sortDir: "asc" | "desc";
};

const DEFAULT_FILTERS: Filters = {
  search: "",
  offer_id: null,
  qualities: [],
  sequences: [],
  funnelStages: [],
  showArchived: false,
  page: 0,
  pageSize: 20,
  sortBy: "created_at",
  sortDir: "desc",
};

const SEARCH_DEBOUNCE_MS = 300;
const FILTER_ALL = "__all__";

const QUALITY_LABEL: Record<CreativeQuality, string> = {
  high: "High",
  average: "Average",
  poor: "Poor",
  unknown: "Unknown",
};

const SEQUENCE_LABEL: Record<CreativeSequencePlacement, string> = {
  warmup: "WarmUp",
  "1st": "1st",
  "2nd": "2nd",
  "3rd": "3rd",
  "4th": "4th",
  "5th": "5th",
  "6th": "6th",
  any: "Any",
  unknown: "Unknown",
};

const FUNNEL_STAGE_LABEL: Record<CreativeFunnelStage, string> = {
  start: "Start",
  clicked: "Clicked",
  checkout: "Checkout",
  ignored: "Ignored",
  unknown: "Unknown",
};

function SlugChip({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(slug);
          setCopied(true);
          setTimeout(() => setCopied(false), 1000);
        } catch {}
      }}
      className="inline-flex items-center gap-1.5 font-mono text-xs hover:text-foreground"
    >
      <span>{slug}</span>
      {copied ? (
        <Check className="size-3 text-emerald-600" aria-hidden />
      ) : (
        <Copy className="size-3 opacity-40" aria-hidden />
      )}
    </button>
  );
}

function OffersCell({ creative }: { creative: Creative }) {
  if (creative.applies_to_all_offers) {
    return (
      <Badge className="border-indigo-200 bg-indigo-100 text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-200">
        All offers
      </Badge>
    );
  }
  if (creative.offers.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const visible = creative.offers.slice(0, 3);
  const extra = creative.offers.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((o) => (
        <span
          key={o.id}
          className="inline-flex items-center gap-1 rounded-full border bg-background px-1.5 py-0.5 text-xs"
        >
          <span
            className="size-2 rounded-full"
            style={{ backgroundColor: o.color ?? "#64748B" }}
          />
          {o.name}
        </span>
      ))}
      {extra > 0 ? (
        <span
          className="text-xs text-muted-foreground"
          title={creative.offers.map((o) => o.name).join(", ")}
        >
          +{extra} more
        </span>
      ) : null}
    </div>
  );
}

function ArchivedBadge() {
  return (
    <Badge className="border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      Archived
    </Badge>
  );
}

const numberFmt = new Intl.NumberFormat("en-US");

function formatPercent(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function formatEpc(v: number): string {
  return `$${v.toFixed(3)}`;
}

// One right-aligned numeric metric cell. Renders "—" when the value is null
// (no data / zero denominator); the title surfaces the underlying counts so a
// rate is never a number without context.
function MetricCell({
  value,
  format,
  title,
}: {
  value: number | null;
  format: (v: number) => string;
  title: string;
}) {
  if (value === null) {
    return (
      <div className="text-right tabular-nums text-muted-foreground">—</div>
    );
  }
  return (
    <div className="text-right tabular-nums" title={title}>
      {format(value)}
    </div>
  );
}

// Compact dot + score for the list view. Green = not_spam, red = spam,
// grey = no score (either never scored or scoring failed). The error
// tooltip surfaces the classifier error when present so the user can
// decide whether to retry.
function SpamScoreCell({ creative }: { creative: Creative }) {
  if (creative.spam_score_error) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400"
        title={`Scoring failed: ${creative.spam_score_error}`}
      >
        <span
          className="size-2 rounded-full bg-amber-500"
          aria-hidden
        />
        <span className="font-mono">err</span>
      </span>
    );
  }
  if (creative.spam_score === null) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-muted-foreground"
        title="Not scored yet"
      >
        <span
          className="size-2 rounded-full bg-muted-foreground/30"
          aria-hidden
        />
        <span className="font-mono">—</span>
      </span>
    );
  }
  const isSpam = creative.spam_verdict === "spam";
  const tooltip = [
    `Score: ${creative.spam_score}/100`,
    isSpam ? "SPAM" : "NOT SPAM",
    creative.spam_model_id ? `Model: ${creative.spam_model_id}` : null,
    creative.spam_scored_at
      ? `Scored: ${format(new Date(creative.spam_scored_at), "MMM d, yyyy HH:mm")}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      className="inline-flex items-center gap-1 text-xs"
      title={tooltip}
    >
      <span
        className={cn(
          "size-2 rounded-full",
          isSpam ? "bg-red-500" : "bg-green-500",
        )}
        aria-hidden
      />
      <span
        className={cn(
          "font-mono tabular-nums",
          isSpam
            ? "text-red-700 dark:text-red-300"
            : "text-green-700 dark:text-green-300",
        )}
      >
        {creative.spam_score}
      </span>
    </span>
  );
}

function truncate(s: string, n: number) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

// Checkbox with native indeterminate support (TanStack/React don't expose
// `indeterminate` as a prop). Used for the header "select page" toggle.
function TriStateCheckbox({
  checked,
  indeterminate,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onClick={(e) => e.stopPropagation()}
      onChange={onChange}
      aria-label={ariaLabel}
      className="size-4 cursor-pointer"
    />
  );
}

export default function CreativesPage() {
  const { auth, can } = useAuth();

  const [filters, updateFilters, resetFilters] = usePersistedFilters<Filters>(
    "creatives.filters",
    DEFAULT_FILTERS,
  );
  const filtersAreDefault =
    filters.search === DEFAULT_FILTERS.search &&
    filters.offer_id === DEFAULT_FILTERS.offer_id &&
    filters.qualities.length === 0 &&
    filters.sequences.length === 0 &&
    filters.funnelStages.length === 0 &&
    filters.showArchived === DEFAULT_FILTERS.showArchived;

  const [searchInput, setSearchInput] = useState(filters.search);
  useEffect(() => {
    setSearchInput(filters.search);
  }, [filters.search]);
  useEffect(() => {
    if (searchInput === filters.search) return;
    const t = setTimeout(() => {
      updateFilters({ search: searchInput, page: 0 });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput, filters.search, updateFilters]);

  const listApi = useApiCall<ListResponse>();
  const bulkCreateApi = useApiCall<{ created: Creative[] }>();
  const updateApi = useApiCall<Creative>();
  const archiveApi = useApiCall<Creative>();
  const restoreApi = useApiCall<Creative>();
  const duplicateApi = useApiCall<Creative>();
  const offersApi = useApiCall<OfferListResponse>();
  const idsApi = useApiCall<{ ids: number[]; truncated: boolean }>();
  const bulkUpdateApi = useApiCall<{ updated: number }>();
  const bulkScoreApi = useApiCall<{
    scored: number;
    skipped: number;
    failed: number;
  }>();

  const [data, setData] = useState<Creative[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refetch = useCallback(() => setRefreshTick((n) => n + 1), []);

  const [offers, setOffers] = useState<OfferInfo[]>([]);
  useEffect(() => {
    (async () => {
      const r = await offersApi.execute("/api/offers/list?pageSize=200");
      if (r.ok) setOffers(r.data.data);
    })();
  }, [offersApi.execute]);

  useEffect(() => {
    let cancelled = false;
    setFetchError(null);
    const sp = new URLSearchParams({
      page: String(filters.page),
      pageSize: String(filters.pageSize),
      sortBy: filters.sortBy,
      sortDir: filters.sortDir,
    });
    if (filters.search) sp.set("search", filters.search);
    if (filters.offer_id !== null) sp.set("offer_id", String(filters.offer_id));
    if (filters.qualities.length > 0)
      sp.set("quality", filters.qualities.join(","));
    if (filters.sequences.length > 0)
      sp.set("sequence_placement", filters.sequences.join(","));
    if (filters.funnelStages.length > 0)
      sp.set("funnel_stage", filters.funnelStages.join(","));
    if (filters.showArchived) sp.set("showArchived", "true");

    (async () => {
      const result = await listApi.execute(
        `/api/creatives/list?${sp.toString()}`,
      );
      if (cancelled) return;
      if (result.ok) {
        setData(result.data.data);
        setTotalCount(result.data.totalCount);
      } else {
        setFetchError(result.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    filters.page,
    filters.pageSize,
    filters.sortBy,
    filters.sortDir,
    filters.search,
    filters.offer_id,
    filters.qualities,
    filters.sequences,
    filters.funnelStages,
    filters.showArchived,
    refreshTick,
    listApi.execute,
  ]);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Creative | null>(null);
  const [confirming, setConfirming] = useState<
    | { kind: "archive"; creative: Creative }
    | { kind: "restore"; creative: Creative }
    | null
  >(null);

  const canCreate = can("creatives.create");
  const canUpdate = can("creatives.update");
  const canArchive = can("creatives.archive");
  const canRestore = can("creatives.restore");
  const canScore = can("spam.score");
  // The selection column + bulk bar appear when the user can do at least
  // one bulk action.
  const canBulkAny = canUpdate || canArchive || canRestore || canScore;

  // ---- Bulk selection ----
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [confirmScoreOpen, setConfirmScoreOpen] = useState(false);
  // Tracks chunked spam-scoring progress; null when idle.
  const [scoreProgress, setScoreProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  // Clear the selection whenever the filter set changes — the visible
  // population is different, so a stale cross-page selection would be
  // confusing. Page changes do NOT clear it, so manual cross-page
  // selection keeps working.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [
    filters.search,
    filters.offer_id,
    filters.qualities,
    filters.sequences,
    filters.showArchived,
  ]);

  function toggleSelected(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Build the filter-only query string (no pagination/sort) for the
  // "all matching ids" endpoint — mirrors the list fetch's filter params.
  const buildFilterParams = useCallback(() => {
    const sp = new URLSearchParams();
    if (filters.search) sp.set("search", filters.search);
    if (filters.offer_id !== null) sp.set("offer_id", String(filters.offer_id));
    if (filters.qualities.length > 0)
      sp.set("quality", filters.qualities.join(","));
    if (filters.sequences.length > 0)
      sp.set("sequence_placement", filters.sequences.join(","));
    if (filters.funnelStages.length > 0)
      sp.set("funnel_stage", filters.funnelStages.join(","));
    if (filters.showArchived) sp.set("showArchived", "true");
    return sp;
  }, [
    filters.search,
    filters.offer_id,
    filters.qualities,
    filters.sequences,
    filters.funnelStages,
    filters.showArchived,
  ]);

  async function handleSelectAllMatching() {
    const sp = buildFilterParams();
    const r = await idsApi.execute(`/api/creatives/ids?${sp.toString()}`);
    if (!r.ok) {
      toastApiError(r, "Couldn't select all matching creatives");
      return;
    }
    setSelectedIds(new Set(r.data.ids));
    if (r.data.truncated) {
      toast.warning(
        `Selected the first ${r.data.ids.length} matching creatives (cap reached)`,
      );
    }
  }

  async function handleBulkUpdate(payload: BulkEditPayload) {
    if (selectedIds.size === 0) return;
    const r = await bulkUpdateApi.execute("/api/creatives/bulk-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        creative_ids: Array.from(selectedIds),
        ...payload,
      }),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't apply bulk changes");
      return;
    }
    const n = r.data.updated;
    toast.success(`${n} creative${n === 1 ? "" : "s"} updated`);
    setBulkEditOpen(false);
    setSelectedIds(new Set());
    refetch();
  }

  // Score the selected creatives in client-side chunks so each request
  // stays short and we can show progress. The server skips already-scored
  // rows; counts are summed across chunks.
  async function handleBulkScore() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const CHUNK = 50;
    let scored = 0;
    let skipped = 0;
    let failed = 0;
    setScoreProgress({ done: 0, total: ids.length });
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const r = await bulkScoreApi.execute("/api/creatives/bulk-score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creative_ids: chunk }),
      });
      if (!r.ok) {
        setScoreProgress(null);
        toastApiError(r, "Spam check failed");
        return;
      }
      scored += r.data.scored;
      skipped += r.data.skipped;
      failed += r.data.failed;
      setScoreProgress({ done: Math.min(i + CHUNK, ids.length), total: ids.length });
    }
    setScoreProgress(null);
    toast.success(
      `Spam check complete — ${scored} scored, ${skipped} skipped${failed > 0 ? `, ${failed} failed` : ""}`,
    );
    refetch();
  }

  async function handleBulkCreate(values: BulkCreativeFormSubmit) {
    const result = await bulkCreateApi.execute("/api/creatives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't create creatives");
      return;
    }
    const n = result.data.created.length;
    toast.success(`${n} creative${n === 1 ? "" : "s"} saved`);
    setCreateOpen(false);
    refetch();
  }

  async function handleEdit(values: CreativeFormValues) {
    if (!editing) return;
    const body = {
      text: values.text,
      creative_id: values.creative_id || undefined,
      quality: values.quality,
      sequence_placement: values.sequence_placement,
      funnel_stage: values.funnel_stage,
      applies_to_all_offers: values.applies_to_all_offers,
      offer_ids: values.offer_ids,
    };
    const result = await updateApi.execute(`/api/creatives/${editing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't save creative");
      return;
    }
    toast.success("Creative saved");
    setEditing(null);
    refetch();
  }

  async function handleConfirm() {
    if (!confirming) return;
    const isArchive = confirming.kind === "archive";
    const api = isArchive ? archiveApi : restoreApi;
    const result = await api.execute(
      `/api/creatives/${confirming.creative.id}/${isArchive ? "archive" : "restore"}`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    toast.success(isArchive ? "Creative archived" : "Creative restored");
    setConfirming(null);
    refetch();
  }

  async function handleDuplicate(creative: Creative) {
    const result = await duplicateApi.execute(
      `/api/creatives/${creative.id}/duplicate`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't duplicate creative");
      return;
    }
    toast.success("Creative duplicated");
    refetch();
    setEditing(result.data);
  }

  const columns = useMemo<ColumnDef<Creative>[]>(() => {
    const pageIds = data.map((d) => d.id);
    const allPageSelected =
      pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
    const somePageSelected = pageIds.some((id) => selectedIds.has(id));
    function toggleSelectPage() {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (allPageSelected) pageIds.forEach((id) => next.delete(id));
        else pageIds.forEach((id) => next.add(id));
        return next;
      });
    }
    const selectColumn: ColumnDef<Creative> = {
      id: "select",
      header: () => (
        <TriStateCheckbox
          checked={allPageSelected}
          indeterminate={somePageSelected}
          onChange={toggleSelectPage}
          ariaLabel="Select all on this page"
        />
      ),
      enableSorting: false,
      cell: ({ row }) => (
        <input
          type="checkbox"
          checked={selectedIds.has(row.original.id)}
          onClick={(e) => e.stopPropagation()}
          onChange={() => toggleSelected(row.original.id)}
          aria-label="Select row"
          className="size-4 cursor-pointer"
        />
      ),
    };
    return [
      ...(canBulkAny ? [selectColumn] : []),
      {
        id: "slug",
        header: "Slug",
        enableSorting: false,
        cell: ({ row }) => <SlugChip slug={row.original.slug} />,
      },
      {
        id: "text",
        header: "Text",
        enableSorting: false,
        cell: ({ row }) => {
          const segs = calculateSmsSegments(row.original.text);
          return (
            <div className="min-w-0">
              <div
                className="truncate text-sm"
                title={row.original.text}
              >
                {truncate(row.original.text, 60)}
              </div>
              <div className="text-xs text-muted-foreground">
                {row.original.text.length}ch / {segs.segments} seg
              </div>
            </div>
          );
        },
      },
      {
        id: "spam_score",
        header: "Spam Score",
        enableSorting: true,
        cell: ({ row }) => <SpamScoreCell creative={row.original} />,
      },
      {
        id: "offers",
        header: "Offers",
        enableSorting: false,
        cell: ({ row }) => <OffersCell creative={row.original} />,
      },
      {
        id: "sequence",
        header: "Sequence",
        enableSorting: true,
        cell: ({ row }) => (
          <Badge variant="outline" className="font-mono text-xs">
            {SEQUENCE_LABEL[row.original.sequence_placement]}
          </Badge>
        ),
      },
      {
        id: "funnel_stage",
        header: "Funnel Stage",
        enableSorting: true,
        cell: ({ row }) => (
          <Badge variant="outline" className="text-xs">
            {FUNNEL_STAGE_LABEL[row.original.funnel_stage]}
          </Badge>
        ),
      },
      {
        id: "status",
        header: "Status",
        enableSorting: true,
        cell: ({ row }) => {
          if (row.original.status === "archived") return <ArchivedBadge />;
          return (
            <Badge className="border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
              Active
            </Badge>
          );
        },
      },
      {
        id: "ctr",
        header: "CTR",
        enableSorting: true,
        cell: ({ row }) => {
          const m = row.original.metrics;
          return (
            <MetricCell
              value={m.ctr}
              format={formatPercent}
              title={`${numberFmt.format(m.clean_clicks)} clean clicks / ${numberFmt.format(m.delivered)} delivered (30d)`}
            />
          );
        },
      },
      {
        id: "checkout_rate",
        header: "Checkout Rate",
        enableSorting: true,
        cell: ({ row }) => {
          const m = row.original.metrics;
          return (
            <MetricCell
              value={m.checkout_rate}
              format={formatPercent}
              title={`${numberFmt.format(m.checkouts)} checkouts / ${numberFmt.format(m.clean_clicks)} clean clicks (30d)`}
            />
          );
        },
      },
      {
        id: "sales_cr",
        header: "Sales CR",
        enableSorting: true,
        cell: ({ row }) => {
          const m = row.original.metrics;
          return (
            <MetricCell
              value={m.sales_cr}
              format={formatPercent}
              title={`${numberFmt.format(m.sales)} sales / ${numberFmt.format(m.clean_clicks)} clean clicks (30d)`}
            />
          );
        },
      },
      {
        id: "epc",
        header: "EPC",
        enableSorting: true,
        cell: ({ row }) => {
          const m = row.original.metrics;
          return (
            <MetricCell
              value={m.epc}
              format={formatEpc}
              title={`$${m.payout.toFixed(2)} payout / ${numberFmt.format(m.clean_clicks)} clean clicks (30d)`}
            />
          );
        },
      },
      {
        id: "created_at",
        header: "Created",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {format(new Date(row.original.created_at), "MMM d, yyyy")}
          </span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const c = row.original;
          const showEdit = canUpdate;
          const showArchive = c.status !== "archived" && canArchive;
          const showRestore = c.status === "archived" && canRestore;
          const showDup = canCreate;
          if (!showEdit && !showArchive && !showRestore && !showDup)
            return null;
          return (
            <div className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  onClick={(e) => e.stopPropagation()}
                >
                  {showEdit ? (
                    <DropdownMenuItem onSelect={() => setEditing(c)}>
                      <Pencil className="size-4" aria-hidden /> Edit
                    </DropdownMenuItem>
                  ) : null}
                  {showDup ? (
                    <DropdownMenuItem onSelect={() => handleDuplicate(c)}>
                      <DuplicateIcon className="size-4" aria-hidden /> Duplicate
                    </DropdownMenuItem>
                  ) : null}
                  {showArchive ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirming({ kind: "archive", creative: c })
                      }
                    >
                      <ArchiveIcon className="size-4" aria-hidden /> Archive
                    </DropdownMenuItem>
                  ) : null}
                  {showRestore ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirming({ kind: "restore", creative: c })
                      }
                    >
                      <ArchiveRestore className="size-4" aria-hidden /> Restore
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      },
    ];
  }, [
    canUpdate,
    canArchive,
    canRestore,
    canCreate,
    canBulkAny,
    data,
    selectedIds,
  ]);

  const isAuthLoading = !auth;
  const confirmBusy = archiveApi.isLoading || restoreApi.isLoading;
  const offerFilterValue =
    filters.offer_id === null ? FILTER_ALL : String(filters.offer_id);

  function toggleQuality(q: CreativeQuality) {
    const set = new Set(filters.qualities);
    if (set.has(q)) set.delete(q);
    else set.add(q);
    updateFilters({
      qualities: Array.from(set) as CreativeQuality[],
      page: 0,
    });
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Creatives</h1>
          <p className="text-sm text-muted-foreground">
            SMS copy linked to offers. Active creatives can be picked when
            building a campaign stage.
          </p>
        </div>
        {canCreate ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden /> New Creatives
          </Button>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by text or creative ID…"
          className="h-9 w-full max-w-sm"
        />
        <Select
          value={offerFilterValue}
          onValueChange={(v) =>
            updateFilters({
              offer_id: v === FILTER_ALL ? null : Number(v),
              page: 0,
            })
          }
        >
          <SelectTrigger className="h-9 w-[200px]">
            <SelectValue placeholder="Any offer" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FILTER_ALL}>Any offer</SelectItem>
            {offers.map((o) => (
              <SelectItem key={o.id} value={String(o.id)}>
                {o.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex flex-wrap items-center gap-1.5">
          {QUALITY_VALUES.map((q) => {
            const active = filters.qualities.includes(q);
            return (
              <button
                key={q}
                type="button"
                onClick={() => toggleQuality(q)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs capitalize transition-colors",
                  active
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background text-muted-foreground hover:bg-muted",
                )}
              >
                {QUALITY_LABEL[q]}
              </button>
            );
          })}
        </div>
        <MultiSelectPicker
          className="w-[200px]"
          options={SEQUENCE_PLACEMENT_VALUES.map((s) => ({
            id: s,
            label: SEQUENCE_LABEL[s],
          }))}
          value={filters.sequences}
          onChange={(next) =>
            updateFilters({
              sequences: next as CreativeSequencePlacement[],
              page: 0,
            })
          }
          placeholder="Any sequence"
          selectedLabel={(n) => `${n} sequence${n === 1 ? "" : "s"}`}
          searchPlaceholder="Filter sequence…"
        />
        <MultiSelectPicker
          className="w-[200px]"
          options={FUNNEL_STAGE_VALUES.map((s) => ({
            id: s,
            label: FUNNEL_STAGE_LABEL[s],
          }))}
          value={filters.funnelStages}
          onChange={(next) =>
            updateFilters({
              funnelStages: next as CreativeFunnelStage[],
              page: 0,
            })
          }
          placeholder="Any funnel stage"
          selectedLabel={(n) => `${n} funnel stage${n === 1 ? "" : "s"}`}
          searchPlaceholder="Filter funnel stage…"
        />
        <div className="flex items-center gap-2">
          <Switch
            id="show-archived"
            checked={filters.showArchived}
            onCheckedChange={(checked) =>
              updateFilters({ showArchived: checked, page: 0 })
            }
          />
          <Label htmlFor="show-archived" className="text-sm">
            Show archived
          </Label>
        </div>
        {!filtersAreDefault ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              resetFilters();
              setSearchInput("");
            }}
          >
            Reset filters
          </Button>
        ) : null}
      </div>

      {canBulkAny && selectedIds.size > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span>
              <span className="font-medium">{selectedIds.size}</span> selected
            </span>
            {selectedIds.size < totalCount ? (
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={handleSelectAllMatching}
                disabled={idsApi.isLoading || !!scoreProgress}
              >
                Select all {totalCount} matching
              </Button>
            ) : null}
            {scoreProgress ? (
              <span className="text-muted-foreground">
                Scoring {scoreProgress.done}/{scoreProgress.total}…
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedIds(new Set())}
              disabled={!!scoreProgress}
            >
              Clear
            </Button>
            {canUpdate || canArchive || canRestore ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setBulkEditOpen(true)}
                disabled={!!scoreProgress}
              >
                <ListChecks className="size-4" aria-hidden /> Bulk edit
              </Button>
            ) : null}
            {canScore ? (
              <Button
                size="sm"
                onClick={() => setConfirmScoreOpen(true)}
                disabled={!!scoreProgress}
              >
                <ScanSearch className="size-4" aria-hidden /> Run spam check
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {fetchError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">
            Couldn&apos;t load creatives: {fetchError}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={refetch}
          >
            Retry
          </Button>
        </div>
      ) : !listApi.isLoading && data.length === 0 && filtersAreDefault ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-16 text-center">
          <MessageSquare
            className="size-12 text-muted-foreground/40"
            aria-hidden
          />
          <div className="space-y-1">
            <p className="text-sm font-medium">No creatives yet</p>
            <p className="text-sm text-muted-foreground">
              Draft your first SMS messages tied to one or more offers.
            </p>
          </div>
          {canCreate ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden /> New Creatives
            </Button>
          ) : null}
        </div>
      ) : !listApi.isLoading && data.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">
            No creatives match your filters.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              resetFilters();
              setSearchInput("");
            }}
          >
            Reset filters
          </Button>
        </div>
      ) : (
        <DataTable<Creative>
          data={data}
          columns={columns}
          isLoading={listApi.isLoading}
          pageIndex={filters.page}
          pageSize={filters.pageSize}
          totalCount={totalCount}
          onPageChange={(p) => updateFilters({ page: p })}
          onPageSizeChange={(s) => updateFilters({ pageSize: s, page: 0 })}
          sortBy={filters.sortBy || null}
          sortDir={filters.sortDir}
          onSortChange={(by, dir) =>
            updateFilters({
              sortBy: by ?? "created_at",
              sortDir: dir,
              page: 0,
            })
          }
          onRowClick={canUpdate ? (c) => setEditing(c) : undefined}
        />
      )}

      <FormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle>New creatives</DialogTitle>
          <DialogDescription>
            Add one or more SMS messages with shared offer + quality + sequence
            settings.
          </DialogDescription>
        </DialogHeader>
        <BulkCreativeForm
          onSubmit={handleBulkCreate}
          onCancel={() => setCreateOpen(false)}
          isSubmitting={bulkCreateApi.isLoading}
        />
      </FormDialog>

      <FormDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>Edit creative</DialogTitle>
          <DialogDescription>
            {editing ? `Slug: ${editing.slug}` : ""}
          </DialogDescription>
        </DialogHeader>
        {editing ? (
          <CreativeForm
            key={`edit-${editing.id}`}
            mode="edit"
            slug={editing.slug}
            initialValues={{
              text: editing.text,
              creative_id: editing.creative_id ?? "",
              quality: editing.quality,
              sequence_placement: editing.sequence_placement,
              funnel_stage: editing.funnel_stage,
              applies_to_all_offers: editing.applies_to_all_offers,
              offer_ids: editing.offers.map((o) => o.id),
            }}
            initialSpamResult={
              editing.spam_score !== null &&
              editing.spam_label !== null &&
              editing.spam_verdict !== null &&
              editing.spam_text_hash !== null
                ? {
                    score: editing.spam_score,
                    label: editing.spam_label,
                    verdict: editing.spam_verdict,
                    textHash: editing.spam_text_hash,
                  }
                : null
            }
            onSubmit={handleEdit}
            onCancel={() => setEditing(null)}
            isSubmitting={updateApi.isLoading}
          />
        ) : null}
      </FormDialog>

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.kind === "archive"
                ? "Archive this creative?"
                : "Restore this creative?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.kind === "archive"
                ? "Archived creatives are hidden from the active list and can't be picked for new stages."
                : "Restoring brings the creative back as active."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirmBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleConfirm();
              }}
              disabled={confirmBusy}
            >
              {confirming?.kind === "archive" ? "Archive" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <FormDialog
        open={bulkEditOpen}
        onOpenChange={setBulkEditOpen}
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Bulk edit creatives</DialogTitle>
          <DialogDescription>
            Apply changes to the selected creatives at once.
          </DialogDescription>
        </DialogHeader>
        <BulkEditForm
          selectedCount={selectedIds.size}
          offers={offers
            .filter((o) => o.status === "active")
            .map((o) => ({ id: o.id, name: o.name, color: o.color }))}
          canEditMeta={canUpdate}
          canArchive={canArchive}
          canRestore={canRestore}
          onSubmit={handleBulkUpdate}
          onCancel={() => setBulkEditOpen(false)}
          isSubmitting={bulkUpdateApi.isLoading}
        />
      </FormDialog>

      <AlertDialog open={confirmScoreOpen} onOpenChange={setConfirmScoreOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run spam check?</AlertDialogTitle>
            <AlertDialogDescription>
              This scores {selectedIds.size} selected creative
              {selectedIds.size === 1 ? "" : "s"}. Already-scored creatives are
              skipped. Scoring calls the classifier service and may take a
              moment for large selections.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                setConfirmScoreOpen(false);
                void handleBulkScore();
              }}
            >
              Run spam check
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isAuthLoading ? (
        <p className="sr-only" aria-live="polite">
          Loading…
        </p>
      ) : null}
    </div>
  );
}
