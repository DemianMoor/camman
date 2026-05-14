"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  ArchiveRestore,
  Archive as ArchiveIcon,
  Check,
  Copy,
  Copy as DuplicateIcon,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import {
  BulkCreativeForm,
  type BulkCreativeFormSubmit,
} from "@/components/creatives/bulk-creative-form";
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
  QUALITY_VALUES,
  SEQUENCE_PLACEMENT_VALUES,
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
  applies_to_all_offers: boolean;
  status: Status;
  archived_at: string | null;
  created_at: string;
  offers: Info[];
  campaign_count: number;
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

const QUALITY_BADGE: Record<CreativeQuality, string> = {
  high: "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  average:
    "border-blue-200 bg-blue-100 text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200",
  poor: "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  unknown:
    "border-zinc-200 bg-zinc-100 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300",
};

const SEQUENCE_LABEL: Record<CreativeSequencePlacement, string> = {
  "1st": "1st",
  "2nd": "2nd",
  "3rd": "3rd",
  any: "Any",
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

  const columns = useMemo<ColumnDef<Creative>[]>(
    () => [
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
        id: "spam",
        header: "Spam Score",
        enableSorting: false,
        cell: ({ row }) => <SpamScoreCell creative={row.original} />,
      },
      {
        id: "offers",
        header: "Offers",
        enableSorting: false,
        cell: ({ row }) => <OffersCell creative={row.original} />,
      },
      {
        id: "quality",
        header: "Quality",
        enableSorting: true,
        cell: ({ row }) => (
          <Badge className={cn("capitalize", QUALITY_BADGE[row.original.quality])}>
            {QUALITY_LABEL[row.original.quality]}
          </Badge>
        ),
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
        id: "campaigns",
        header: "Campaigns",
        enableSorting: false,
        cell: ({ row }) => {
          const n = row.original.campaign_count;
          if (n === 0) return <span className="text-muted-foreground">—</span>;
          return <Badge variant="secondary">{n}</Badge>;
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
    ],
    [canUpdate, canArchive, canRestore, canCreate],
  );

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

  function toggleSequence(s: CreativeSequencePlacement) {
    const set = new Set(filters.sequences);
    if (set.has(s)) set.delete(s);
    else set.add(s);
    updateFilters({
      sequences: Array.from(set) as CreativeSequencePlacement[],
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
        <div className="flex flex-wrap items-center gap-1.5">
          {SEQUENCE_PLACEMENT_VALUES.map((s) => {
            const active = filters.sequences.includes(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleSequence(s)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs transition-colors",
                  active
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background text-muted-foreground hover:bg-muted",
                )}
              >
                {SEQUENCE_LABEL[s]}
              </button>
            );
          })}
        </div>
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

      {isAuthLoading ? (
        <p className="sr-only" aria-live="polite">
          Loading…
        </p>
      ) : null}
    </div>
  );
}
