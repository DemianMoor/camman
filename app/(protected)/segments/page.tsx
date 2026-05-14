"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  ArchiveRestore,
  Archive as ArchiveIcon,
  GitMerge,
  Layers,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/data-table";
import { ExportButton } from "@/components/export-button";
import { useAuth } from "@/components/protected/auth-context";
import {
  SegmentForm,
  type SegmentFormValues,
} from "@/components/segments/segment-form";
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
  DropdownMenuSeparator,
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
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { cn } from "@/lib/utils";

type SegmentStats = {
  total_count: number;
  opt_out_count: number;
  opt_in_count: number;
  clicker_count: number;
  rule_filtered_count: number | null;
  updated_at: string | null;
};

// Groups no longer appear on segments (groups are on contacts now). The
// list row exposes `active_rules_count` so we can render a "Rules" badge
// and offer a has-rules filter in place of the old group filter.
type Segment = {
  id: number;
  segment_id: string;
  org_id: string;
  name: string;
  original_name: string | null;
  status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
  active_rules_count: number;
  stats: SegmentStats;
};

type ListResponse = {
  data: Segment[];
  totalCount: number;
  page: number;
  pageSize: number;
};

type Filters = {
  search: string;
  has_rules: "all" | "with" | "without";
  showArchived: boolean;
  page: number;
  pageSize: number;
  sortBy: string;
  sortDir: "asc" | "desc";
};

const DEFAULT_FILTERS: Filters = {
  search: "",
  has_rules: "all",
  showArchived: false,
  page: 0,
  pageSize: 20,
  sortBy: "created_at",
  sortDir: "desc",
};

const SEARCH_DEBOUNCE_MS = 300;

function StatusBadge({ status }: { status: Segment["status"] }) {
  if (status === "active") {
    return (
      <Badge className="border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
        Active
      </Badge>
    );
  }
  return (
    <Badge className="border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      Archived
    </Badge>
  );
}

function CountBadge({
  count,
  tone,
}: {
  count: number;
  tone?: "red" | "green" | "neutral";
}) {
  if (count === 0) return <span className="text-muted-foreground">—</span>;
  const cls =
    tone === "red"
      ? "border-rose-200 bg-rose-100 text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
      : tone === "green"
        ? "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
        : "";
  return tone ? (
    <Badge className={cls}>{count.toLocaleString()}</Badge>
  ) : (
    <Badge variant="secondary">{count.toLocaleString()}</Badge>
  );
}

export default function SegmentsPage() {
  const router = useRouter();
  const { auth, can } = useAuth();

  const [filters, updateFilters, resetFilters] = usePersistedFilters<Filters>(
    "segments.filters",
    DEFAULT_FILTERS,
  );
  const filtersAreDefault =
    filters.search === DEFAULT_FILTERS.search &&
    filters.has_rules === DEFAULT_FILTERS.has_rules &&
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
  const createApi = useApiCall<Segment>();
  const updateApi = useApiCall<Segment>();
  const archiveApi = useApiCall<Segment>();
  const restoreApi = useApiCall<Segment>();
  const deleteApi = useApiCall<{ deleted: boolean }>();
  const refreshApi = useApiCall<SegmentStats>();

  const [data, setData] = useState<Segment[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refetch = useCallback(() => setRefreshTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setFetchError(null);
    const params = new URLSearchParams({
      page: String(filters.page),
      pageSize: String(filters.pageSize),
      sortBy: filters.sortBy,
      sortDir: filters.sortDir,
    });
    if (filters.search) params.set("search", filters.search);
    if (filters.showArchived) params.set("showArchived", "true");
    if (filters.has_rules !== "all") params.set("has_rules", filters.has_rules);
    (async () => {
      const result = await listApi.execute(
        `/api/segments/list?${params.toString()}`,
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
    filters.has_rules,
    filters.showArchived,
    refreshTick,
    listApi.execute,
  ]);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Segment | null>(null);
  const [confirming, setConfirming] = useState<
    | { kind: "archive"; segment: Segment }
    | { kind: "restore"; segment: Segment }
    | { kind: "delete"; segment: Segment }
    | null
  >(null);

  const canCreate = can("segments.create");
  const canUpdate = can("segments.update");
  const canArchive = can("segments.archive");
  const canRestore = can("segments.restore");
  const canDelete = can("segments.delete");

  async function handleCreate(values: SegmentFormValues) {
    const result = await createApi.execute("/api/segments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't create segment");
      return;
    }
    toast.success("Segment created");
    setCreateOpen(false);
    refetch();
  }

  async function handleEdit(values: SegmentFormValues) {
    if (!editing) return;
    const { segment_id: _omit, ...patch } = values;
    const result = await updateApi.execute(`/api/segments/${editing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't save segment");
      return;
    }
    toast.success("Segment saved");
    setEditing(null);
    refetch();
  }

  async function handleConfirm() {
    if (!confirming) return;
    const { kind, segment } = confirming;
    if (kind === "delete") {
      const result = await deleteApi.execute(`/api/segments/${segment.id}`, {
        method: "DELETE",
      });
      if (!result.ok) {
        toastApiError(result, "Couldn't delete segment");
        return;
      }
      toast.success("Segment deleted");
    } else {
      const isArchive = kind === "archive";
      const api = isArchive ? archiveApi : restoreApi;
      const result = await api.execute(
        `/api/segments/${segment.id}/${isArchive ? "archive" : "restore"}`,
        { method: "POST" },
      );
      if (!result.ok) {
        toastApiError(
          result,
          isArchive ? "Couldn't archive segment" : "Couldn't restore segment",
        );
        return;
      }
      toast.success(isArchive ? "Segment archived" : "Segment restored");
    }
    setConfirming(null);
    refetch();
  }

  async function handleRefreshStats(segment: Segment) {
    const result = await refreshApi.execute(
      `/api/segments/${segment.id}/refresh-stats`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't refresh stats");
      return;
    }
    toast.success("Stats refreshed");
    refetch();
  }

  const columns = useMemo<ColumnDef<Segment>[]>(
    () => [
      {
        id: "name",
        header: "Segment",
        enableSorting: true,
        cell: ({ row }) => {
          const s = row.original;
          const showOriginal =
            s.original_name && s.original_name !== s.name
              ? s.original_name
              : null;
          return (
            <div className="min-w-0">
              <div className="truncate font-medium">{s.name}</div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {s.segment_id}
                {showOriginal ? ` · (formerly ${showOriginal})` : ""}
              </div>
            </div>
          );
        },
      },
      {
        id: "rules",
        header: "Rules",
        enableSorting: false,
        cell: ({ row }) => {
          const n = row.original.active_rules_count;
          if (n === 0) return <span className="text-muted-foreground">—</span>;
          return (
            <Badge
              className="border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-200"
              title={`${n} active rule${n === 1 ? "" : "s"}`}
            >
              {n}
            </Badge>
          );
        },
      },
      {
        id: "total",
        header: "Contacts",
        enableSorting: false,
        cell: ({ row }) => <CountBadge count={row.original.stats.total_count} />,
      },
      {
        id: "opt_outs",
        header: "Opt-Outs",
        enableSorting: false,
        cell: ({ row }) => (
          <CountBadge count={row.original.stats.opt_out_count} tone="red" />
        ),
      },
      {
        id: "opt_ins",
        header: "Opt-Ins",
        enableSorting: false,
        cell: ({ row }) => (
          <CountBadge count={row.original.stats.opt_in_count} tone="green" />
        ),
      },
      {
        id: "clickers",
        header: "Clickers",
        enableSorting: false,
        cell: ({ row }) => (
          <CountBadge count={row.original.stats.clicker_count} />
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
        enableSorting: true,
      },
      {
        id: "created_at",
        header: "Created",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {format(new Date(row.original.created_at), "MMM d, yyyy")}
          </span>
        ),
        enableSorting: true,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const seg = row.original;
          const showEdit = canUpdate;
          const showArchive = seg.status === "active" && canArchive;
          const showRestore = seg.status === "archived" && canRestore;
          const showRefresh = canUpdate;
          const showDelete = canDelete;
          if (
            !showEdit &&
            !showArchive &&
            !showRestore &&
            !showRefresh &&
            !showDelete
          )
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
                    <DropdownMenuItem onSelect={() => setEditing(seg)}>
                      <Pencil className="size-4" aria-hidden /> Edit
                    </DropdownMenuItem>
                  ) : null}
                  {showRefresh ? (
                    <DropdownMenuItem
                      onSelect={() => handleRefreshStats(seg)}
                      disabled={refreshApi.isLoading}
                    >
                      <RefreshCw className="size-4" aria-hidden /> Refresh stats
                    </DropdownMenuItem>
                  ) : null}
                  {showArchive ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirming({ kind: "archive", segment: seg })
                      }
                    >
                      <ArchiveIcon className="size-4" aria-hidden /> Archive
                    </DropdownMenuItem>
                  ) : null}
                  {showRestore ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirming({ kind: "restore", segment: seg })
                      }
                    >
                      <ArchiveRestore className="size-4" aria-hidden /> Restore
                    </DropdownMenuItem>
                  ) : null}
                  {showDelete ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={() =>
                          setConfirming({ kind: "delete", segment: seg })
                        }
                      >
                        <Trash2 className="size-4" aria-hidden /> Delete
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      },
    ],
    [
      canUpdate,
      canArchive,
      canRestore,
      canDelete,
      refreshApi.isLoading,
      handleRefreshStats,
    ],
  );

  const isAuthLoading = !auth;
  const confirmBusy =
    archiveApi.isLoading || restoreApi.isLoading || deleteApi.isLoading;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Segments</h1>
          <p className="text-sm text-muted-foreground">
            Named lists of contacts used as campaign audiences.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/segments/charts">
            <Button variant="outline">
              <GitMerge className="size-4" aria-hidden /> View Overlaps
            </Button>
          </Link>
          {canCreate ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden /> New Segment
            </Button>
          ) : null}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by name or segment ID…"
          className="h-9 w-full max-w-sm"
        />
        <Select
          value={filters.has_rules}
          onValueChange={(v) =>
            updateFilters({
              has_rules: v as Filters["has_rules"],
              page: 0,
            })
          }
        >
          <SelectTrigger className="h-9 w-[180px]">
            <SelectValue placeholder="All segments" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All segments</SelectItem>
            <SelectItem value="with">With rules</SelectItem>
            <SelectItem value="without">Without rules</SelectItem>
          </SelectContent>
        </Select>
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
        <div className="ml-auto">
          <ExportButton
            endpoint="/api/segments/export"
            permission="segments.view"
            filenamePrefix="segments"
            queryParams={{
              search: filters.search || undefined,
              has_rules: filters.has_rules !== "all" ? filters.has_rules : undefined,
              showArchived: filters.showArchived ? "true" : undefined,
              sortBy: filters.sortBy,
              sortDir: filters.sortDir,
            }}
            disabledIfEmpty={totalCount}
          />
        </div>
      </div>

      {fetchError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">
            Couldn&apos;t load segments: {fetchError}
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
        <div
          className={cn(
            "flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-16 text-center",
          )}
        >
          <Layers className="size-12 text-muted-foreground/40" aria-hidden />
          <div className="space-y-1">
            <p className="text-sm font-medium">No segments yet</p>
            <p className="text-sm text-muted-foreground">
              Create a segment, then upload phone numbers to fill it.
            </p>
          </div>
          {canCreate ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden /> New Segment
            </Button>
          ) : null}
        </div>
      ) : !listApi.isLoading && data.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">
            No segments match your filters.
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
        <DataTable<Segment>
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
          onRowClick={(s) => router.push(`/segments/${s.id}`)}
        />
      )}

      {/* Create dialog */}
      <FormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>New segment</DialogTitle>
          <DialogDescription>
            A named list of contacts. Add phones after creation.
          </DialogDescription>
        </DialogHeader>
        <SegmentForm
          key="create"
          mode="create"
          onSubmit={handleCreate}
          onCancel={() => setCreateOpen(false)}
          isSubmitting={createApi.isLoading}
        />
      </FormDialog>

      {/* Edit dialog */}
      <FormDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Edit segment</DialogTitle>
          <DialogDescription>{editing ? editing.name : ""}</DialogDescription>
        </DialogHeader>
        {editing ? (
          <SegmentForm
            key={`edit-${editing.id}`}
            mode="edit"
            initialValues={{
              name: editing.name,
              segment_id: editing.segment_id,
              original_name: editing.original_name ?? "",
            }}
            onSubmit={handleEdit}
            onCancel={() => setEditing(null)}
            isSubmitting={updateApi.isLoading}
          />
        ) : null}
      </FormDialog>

      {/* Archive / Restore / Delete confirm */}
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
                ? "Archive this segment?"
                : confirming?.kind === "restore"
                  ? "Restore this segment?"
                  : "Delete this segment permanently?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.kind === "archive"
                ? "Archived segments are hidden but their membership is preserved."
                : confirming?.kind === "restore"
                  ? "Restoring a segment moves it back into the active list."
                  : "This permanently removes the segment, its membership, and stats. Cannot be undone."}
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
              className={
                confirming?.kind === "delete"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : ""
              }
            >
              {confirming?.kind === "archive"
                ? "Archive"
                : confirming?.kind === "restore"
                  ? "Restore"
                  : "Delete permanently"}
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
