"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  ArchiveRestore,
  Archive as ArchiveIcon,
  FolderTree,
  MoreHorizontal,
  Pencil,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import {
  SegmentGroupForm,
  type SegmentGroupFormValues,
} from "@/components/segment-groups/segment-group-form";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { cn } from "@/lib/utils";

type SegmentGroup = {
  id: number;
  segment_group_id: string;
  name: string;
  description: string | null;
  color: string | null;
  status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
  org_id: string;
  segment_count: number;
};

type ListResponse = {
  data: SegmentGroup[];
  totalCount: number;
  page: number;
  pageSize: number;
};

type Filters = {
  search: string;
  showArchived: boolean;
  page: number;
  pageSize: number;
  sortBy: string;
  sortDir: "asc" | "desc";
};

const DEFAULT_FILTERS: Filters = {
  search: "",
  showArchived: false,
  page: 0,
  pageSize: 20,
  sortBy: "created_at",
  sortDir: "desc",
};

const SEARCH_DEBOUNCE_MS = 300;

function GroupCell({ row }: { row: SegmentGroup }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="size-3 shrink-0 rounded-full"
        style={{ backgroundColor: row.color ?? "#64748B" }}
      />
      <div className="min-w-0">
        <div className="truncate font-medium">{row.name}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {row.segment_group_id}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: SegmentGroup["status"] }) {
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

export default function SegmentGroupsPage() {
  const { auth, can } = useAuth();

  const [filters, updateFilters, resetFilters] = usePersistedFilters<Filters>(
    "segment-groups.filters",
    DEFAULT_FILTERS,
  );
  const filtersAreDefault =
    filters.search === DEFAULT_FILTERS.search &&
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
  const createApi = useApiCall<SegmentGroup>();
  const updateApi = useApiCall<SegmentGroup>();
  const archiveApi = useApiCall<SegmentGroup>();
  const restoreApi = useApiCall<SegmentGroup>();

  const [data, setData] = useState<SegmentGroup[]>([]);
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

    (async () => {
      const result = await listApi.execute(
        `/api/segment-groups/list?${params.toString()}`,
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
    filters.showArchived,
    refreshTick,
    listApi.execute,
  ]);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<SegmentGroup | null>(null);
  const [confirming, setConfirming] = useState<
    | { kind: "archive"; row: SegmentGroup }
    | { kind: "restore"; row: SegmentGroup }
    | null
  >(null);

  const canCreate = can("segment_groups.create");
  const canUpdate = can("segment_groups.update");
  const canArchive = can("segment_groups.archive");
  const canRestore = can("segment_groups.restore");

  async function handleCreate(values: SegmentGroupFormValues) {
    const result = await createApi.execute("/api/segment-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't create segment group");
      return;
    }
    toast.success("Segment group created");
    setCreateOpen(false);
    refetch();
  }

  async function handleEdit(values: SegmentGroupFormValues) {
    if (!editing) return;
    const { segment_group_id: _omit, ...patch } = values;
    const result = await updateApi.execute(
      `/api/segment-groups/${editing.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't save segment group");
      return;
    }
    toast.success("Segment group saved");
    setEditing(null);
    refetch();
  }

  async function handleConfirm() {
    if (!confirming) return;
    const isArchive = confirming.kind === "archive";
    const api = isArchive ? archiveApi : restoreApi;
    const result = await api.execute(
      `/api/segment-groups/${confirming.row.id}/${isArchive ? "archive" : "restore"}`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    toast.success(
      isArchive ? "Segment group archived" : "Segment group restored",
    );
    setConfirming(null);
    refetch();
  }

  const columns = useMemo<ColumnDef<SegmentGroup>[]>(
    () => [
      {
        id: "name",
        header: "Group",
        cell: ({ row }) => <GroupCell row={row.original} />,
        enableSorting: true,
      },
      {
        id: "description",
        header: "Description",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.description ? (
            <span className="line-clamp-2 max-w-md text-sm text-muted-foreground">
              {row.original.description}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "segment_count",
        header: "Segments",
        enableSorting: false,
        cell: ({ row }) => {
          const n = row.original.segment_count ?? 0;
          if (n === 0) return <span className="text-muted-foreground">—</span>;
          return (
            <Badge variant="secondary">
              {n} {n === 1 ? "segment" : "segments"}
            </Badge>
          );
        },
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
          const r = row.original;
          const showEdit = canUpdate;
          const showArchive = r.status === "active" && canArchive;
          const showRestore = r.status === "archived" && canRestore;
          if (!showEdit && !showArchive && !showRestore) return null;
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
                    <DropdownMenuItem onSelect={() => setEditing(r)}>
                      <Pencil className="size-4" aria-hidden /> Edit
                    </DropdownMenuItem>
                  ) : null}
                  {showArchive ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirming({ kind: "archive", row: r })
                      }
                    >
                      <ArchiveIcon className="size-4" aria-hidden /> Archive
                    </DropdownMenuItem>
                  ) : null}
                  {showRestore ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirming({ kind: "restore", row: r })
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
    [canUpdate, canArchive, canRestore],
  );

  const isAuthLoading = !auth;
  const confirmBusy = archiveApi.isLoading || restoreApi.isLoading;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Segment Groups
          </h1>
          <p className="text-sm text-muted-foreground">
            Organize segments into themed groups. Segments themselves arrive in
            Step 6.
          </p>
        </div>
        {canCreate ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden /> New Segment Group
          </Button>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by name, ID, or description…"
          className="h-9 w-full max-w-sm"
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

      {fetchError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">
            Couldn&apos;t load segment groups: {fetchError}
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
          <FolderTree
            className="size-12 text-muted-foreground/40"
            aria-hidden
          />
          <div className="space-y-1">
            <p className="text-sm font-medium">No segment groups yet</p>
            <p className="text-sm text-muted-foreground">
              Add a group to organize your segments.
            </p>
          </div>
          {canCreate ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden /> New Segment Group
            </Button>
          ) : null}
        </div>
      ) : !listApi.isLoading && data.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">
            No segment groups match your filters.
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
        <DataTable<SegmentGroup>
          data={data}
          columns={columns}
          isLoading={listApi.isLoading}
          pageIndex={filters.page}
          pageSize={filters.pageSize}
          totalCount={totalCount}
          onPageChange={(p) => updateFilters({ page: p })}
          onPageSizeChange={(s) =>
            updateFilters({ pageSize: s, page: 0 })
          }
          sortBy={filters.sortBy || null}
          sortDir={filters.sortDir}
          onSortChange={(by, dir) =>
            updateFilters({
              sortBy: by ?? "created_at",
              sortDir: dir,
              page: 0,
            })
          }
          onRowClick={canUpdate ? (r) => setEditing(r) : undefined}
        />
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New segment group</DialogTitle>
            <DialogDescription>
              Group segments by theme or use case.
            </DialogDescription>
          </DialogHeader>
          <SegmentGroupForm
            key="create"
            mode="create"
            onSubmit={handleCreate}
            onCancel={() => setCreateOpen(false)}
            isSubmitting={createApi.isLoading}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit segment group</DialogTitle>
            <DialogDescription>
              {editing ? editing.name : ""}
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <SegmentGroupForm
              key={`edit-${editing.id}`}
              mode="edit"
              initialValues={{
                name: editing.name,
                segment_group_id: editing.segment_group_id,
                description: editing.description ?? "",
                color: editing.color ?? "",
              }}
              onSubmit={handleEdit}
              onCancel={() => setEditing(null)}
              isSubmitting={updateApi.isLoading}
            />
          ) : null}
        </DialogContent>
      </Dialog>

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
                ? "Archive this segment group?"
                : "Restore this segment group?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.kind === "archive"
                ? "Archived groups are hidden from the active list but their data is preserved."
                : "Restoring a group moves it back into the active list."}
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
          Loading account…
        </p>
      ) : null}
    </div>
  );
}
