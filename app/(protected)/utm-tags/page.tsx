"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  ArchiveRestore,
  Archive as ArchiveIcon,
  Link as LinkIcon,
  MoreHorizontal,
  Pencil,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import {
  UtmTagForm,
  type UtmTagFormValues,
} from "@/components/utm-tags/utm-tag-form";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api/toast-error";
import { isEntityAvailable } from "@/lib/feature-flags";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { cn } from "@/lib/utils";

type Network = {
  id: number;
  name: string;
  color: string | null;
  avatar_url: string | null;
};

type UtmTag = {
  id: number;
  tag_id: string;
  label: string;
  value_source: string;
  affiliate_network_id: number | null;
  color: string | null;
  status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
  org_id: string;
  network: Network | null;
};

type ListResponse = {
  data: UtmTag[];
  totalCount: number;
  page: number;
  pageSize: number;
};

type NetworksListResponse = { data: Network[]; totalCount: number };

type Filters = {
  search: string;
  showArchived: boolean;
  page: number;
  pageSize: number;
  sortBy: string;
  sortDir: "asc" | "desc";
  networkFilter: number | null;
};

const DEFAULT_FILTERS: Filters = {
  search: "",
  showArchived: false,
  page: 0,
  pageSize: 20,
  sortBy: "created_at",
  sortDir: "desc",
  networkFilter: null,
};

const SEARCH_DEBOUNCE_MS = 300;
const NETWORK_FILTER_ALL = "__all__";

function TagCell({ tag }: { tag: UtmTag }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="size-3 shrink-0 rounded-full"
        style={{ backgroundColor: tag.color ?? "#64748B" }}
      />
      <div className="min-w-0">
        <div className="truncate font-medium">{tag.label}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {tag.tag_id}
        </div>
      </div>
    </div>
  );
}

function NetworkCell({ network }: { network: Network | null }) {
  if (!network)
    return <span className="text-xs text-muted-foreground">All networks</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="size-3 rounded-full"
        style={{ backgroundColor: network.color ?? "#64748B" }}
      />
      <span className="text-sm">{network.name}</span>
    </span>
  );
}

function StatusBadge({ status }: { status: UtmTag["status"] }) {
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

export default function UtmTagsPage() {
  const { auth, can } = useAuth();

  const [filters, updateFilters, resetFilters] = usePersistedFilters<Filters>(
    "utm-tags.filters",
    DEFAULT_FILTERS,
  );
  const filtersAreDefault =
    filters.search === DEFAULT_FILTERS.search &&
    filters.showArchived === DEFAULT_FILTERS.showArchived &&
    filters.networkFilter === DEFAULT_FILTERS.networkFilter;

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
  const createApi = useApiCall<UtmTag>();
  const updateApi = useApiCall<UtmTag>();
  const archiveApi = useApiCall<UtmTag>();
  const restoreApi = useApiCall<UtmTag>();
  const networksApi = useApiCall<NetworksListResponse>();

  const [data, setData] = useState<UtmTag[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refetch = useCallback(() => setRefreshTick((n) => n + 1), []);

  const networksAvailable = isEntityAvailable("networks");
  const [networks, setNetworks] = useState<Network[]>([]);

  useEffect(() => {
    if (!networksAvailable) return;
    let cancelled = false;
    (async () => {
      const result = await networksApi.execute(
        "/api/networks/list?pageSize=100",
      );
      if (cancelled) return;
      if (result.ok) setNetworks(result.data.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [networksAvailable, networksApi.execute]);

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
    if (filters.networkFilter !== null) {
      params.set("affiliate_network_id", String(filters.networkFilter));
    }

    (async () => {
      const result = await listApi.execute(
        `/api/utm-tags/list?${params.toString()}`,
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
    filters.networkFilter,
    refreshTick,
    listApi.execute,
  ]);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<UtmTag | null>(null);
  const [confirming, setConfirming] = useState<
    | { kind: "archive"; tag: UtmTag }
    | { kind: "restore"; tag: UtmTag }
    | null
  >(null);

  const canCreate = can("utm_tags.create");
  const canUpdate = can("utm_tags.update");
  const canArchive = can("utm_tags.archive");
  const canRestore = can("utm_tags.restore");

  async function handleCreate(values: UtmTagFormValues) {
    const result = await createApi.execute("/api/utm-tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't create UTM tag");
      return;
    }
    toast.success("UTM tag created");
    setCreateOpen(false);
    refetch();
  }

  async function handleEdit(values: UtmTagFormValues) {
    if (!editing) return;
    const { tag_id: _omit, ...patch } = values;
    const result = await updateApi.execute(`/api/utm-tags/${editing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't save UTM tag");
      return;
    }
    toast.success("UTM tag saved");
    setEditing(null);
    refetch();
  }

  async function handleConfirm() {
    if (!confirming) return;
    const isArchive = confirming.kind === "archive";
    const api = isArchive ? archiveApi : restoreApi;
    const result = await api.execute(
      `/api/utm-tags/${confirming.tag.id}/${isArchive ? "archive" : "restore"}`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    toast.success(isArchive ? "UTM tag archived" : "UTM tag restored");
    setConfirming(null);
    refetch();
  }

  const columns = useMemo<ColumnDef<UtmTag>[]>(
    () => [
      {
        id: "label",
        header: "Tag",
        cell: ({ row }) => <TagCell tag={row.original} />,
        enableSorting: true,
      },
      {
        id: "value_source",
        header: "Value Source",
        enableSorting: true,
        cell: ({ row }) => (
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            {row.original.value_source}
          </code>
        ),
      },
      {
        id: "network",
        header: "Network",
        enableSorting: false,
        cell: ({ row }) => <NetworkCell network={row.original.network} />,
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
          const t = row.original;
          const showEdit = canUpdate;
          const showArchive = t.status === "active" && canArchive;
          const showRestore = t.status === "archived" && canRestore;
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
                    <DropdownMenuItem onSelect={() => setEditing(t)}>
                      <Pencil className="size-4" aria-hidden /> Edit
                    </DropdownMenuItem>
                  ) : null}
                  {showArchive ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirming({ kind: "archive", tag: t })
                      }
                    >
                      <ArchiveIcon className="size-4" aria-hidden /> Archive
                    </DropdownMenuItem>
                  ) : null}
                  {showRestore ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirming({ kind: "restore", tag: t })
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
  const networkFilterValue =
    filters.networkFilter === null
      ? NETWORK_FILTER_ALL
      : String(filters.networkFilter);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">UTM Tags</h1>
          <p className="text-sm text-muted-foreground">
            Reusable tracking parameters for affiliate link generation.
          </p>
        </div>
        {canCreate ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden /> New UTM Tag
          </Button>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by label, tag ID, or value source…"
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
        <Select
          value={networkFilterValue}
          onValueChange={(v) =>
            updateFilters({
              networkFilter: v === NETWORK_FILTER_ALL ? null : Number(v),
              page: 0,
            })
          }
          disabled={!networksAvailable}
        >
          <SelectTrigger className="h-9 w-[200px]">
            <SelectValue
              placeholder={
                !networksAvailable ? "Networks unavailable" : "All networks"
              }
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NETWORK_FILTER_ALL}>All networks</SelectItem>
            {networks.map((n) => (
              <SelectItem key={n.id} value={String(n.id)}>
                {n.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
            Couldn&apos;t load UTM tags: {fetchError}
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
          <LinkIcon
            className="size-12 text-muted-foreground/40"
            aria-hidden
          />
          <div className="space-y-1">
            <p className="text-sm font-medium">No UTM tags yet</p>
            <p className="text-sm text-muted-foreground">
              Add tags to use in affiliate link generation.
            </p>
          </div>
          {canCreate ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden /> New UTM Tag
            </Button>
          ) : null}
        </div>
      ) : !listApi.isLoading && data.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">
            No UTM tags match your filters.
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
        <DataTable<UtmTag>
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
          onRowClick={canUpdate ? (t) => setEditing(t) : undefined}
        />
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New UTM tag</DialogTitle>
            <DialogDescription>
              Reusable tracking parameters.
            </DialogDescription>
          </DialogHeader>
          <UtmTagForm
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
            <DialogTitle>Edit UTM tag</DialogTitle>
            <DialogDescription>
              {editing ? editing.label : ""}
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <UtmTagForm
              key={`edit-${editing.id}`}
              mode="edit"
              initialValues={{
                label: editing.label,
                tag_id: editing.tag_id,
                value_source: editing.value_source,
                affiliate_network_id: editing.affiliate_network_id,
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
                ? "Archive this UTM tag?"
                : "Restore this UTM tag?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.kind === "archive"
                ? "Archived tags are hidden from the active list but their data is preserved."
                : "Restoring a tag moves it back into the active list."}
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
