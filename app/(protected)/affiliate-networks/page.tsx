"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  ArchiveRestore,
  Archive as ArchiveIcon,
  ExternalLink,
  MoreHorizontal,
  Network as NetworkIcon,
  Pencil,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import {
  NetworkForm,
  type NetworkFormValues,
} from "@/components/networks/network-form";
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

type Network = {
  id: number;
  network_id: string;
  name: string;
  url: string | null;
  avatar_url: string | null;
  color: string | null;
  status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
  org_id: string;
  offer_count: number;
};

type ListResponse = {
  data: Network[];
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

function NetworkCell({ network }: { network: Network }) {
  const initial = network.name.charAt(0).toUpperCase() || "?";
  return (
    <div className="flex items-center gap-3">
      <div
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white"
        style={{ backgroundColor: network.color ?? "#64748B" }}
      >
        {initial}
      </div>
      <div className="min-w-0">
        <div className="truncate font-medium">{network.name}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {network.network_id}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Network["status"] }) {
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

export default function AffiliateNetworksPage() {
  const { auth, can } = useAuth();

  const [filters, updateFilters, resetFilters] = usePersistedFilters<Filters>(
    "networks.filters",
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
  const createApi = useApiCall<Network>();
  const updateApi = useApiCall<Network>();
  const archiveApi = useApiCall<Network>();
  const restoreApi = useApiCall<Network>();

  const [data, setData] = useState<Network[]>([]);
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
        `/api/networks/list?${params.toString()}`,
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
  const [editing, setEditing] = useState<Network | null>(null);
  const [confirming, setConfirming] = useState<
    | { kind: "archive"; network: Network }
    | { kind: "restore"; network: Network }
    | null
  >(null);

  const canCreate = can("networks.create");
  const canUpdate = can("networks.update");
  const canArchive = can("networks.archive");
  const canRestore = can("networks.restore");

  async function handleCreate(values: NetworkFormValues) {
    const result = await createApi.execute("/api/networks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't create network");
      return;
    }
    toast.success("Network created");
    setCreateOpen(false);
    refetch();
  }

  async function handleEdit(values: NetworkFormValues) {
    if (!editing) return;
    const { network_id: _omit, ...patch } = values;
    const result = await updateApi.execute(`/api/networks/${editing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't save network");
      return;
    }
    toast.success("Network saved");
    setEditing(null);
    refetch();
  }

  async function handleConfirm() {
    if (!confirming) return;
    const isArchive = confirming.kind === "archive";
    const api = isArchive ? archiveApi : restoreApi;
    const result = await api.execute(
      `/api/networks/${confirming.network.id}/${isArchive ? "archive" : "restore"}`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(
        result,
        isArchive ? "Couldn't archive network" : "Couldn't restore network",
      );
      return;
    }
    toast.success(isArchive ? "Network archived" : "Network restored");
    setConfirming(null);
    refetch();
  }

  const columns = useMemo<ColumnDef<Network>[]>(
    () => [
      {
        id: "name",
        header: "Network",
        cell: ({ row }) => <NetworkCell network={row.original} />,
        enableSorting: true,
      },
      {
        id: "url",
        header: "URL",
        enableSorting: false,
        cell: ({ row }) => {
          const url = row.original.url;
          if (!url) return <span className="text-muted-foreground">—</span>;
          return (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline"
            >
              <span className="max-w-[260px] truncate">{url}</span>
              <ExternalLink className="size-3 shrink-0" aria-hidden />
            </a>
          );
        },
      },
      {
        id: "offer_count",
        header: "Offers",
        enableSorting: false,
        cell: ({ row }) => {
          const n = row.original.offer_count ?? 0;
          if (n === 0) return <span className="text-muted-foreground">—</span>;
          return (
            <Badge variant="secondary">
              {n} {n === 1 ? "offer" : "offers"}
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
          const network = row.original;
          const showEdit = canUpdate;
          const showArchive = network.status === "active" && canArchive;
          const showRestore = network.status === "archived" && canRestore;
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
                    <DropdownMenuItem onSelect={() => setEditing(network)}>
                      <Pencil className="size-4" aria-hidden /> Edit
                    </DropdownMenuItem>
                  ) : null}
                  {showArchive ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirming({ kind: "archive", network })
                      }
                    >
                      <ArchiveIcon className="size-4" aria-hidden /> Archive
                    </DropdownMenuItem>
                  ) : null}
                  {showRestore ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirming({ kind: "restore", network })
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
            Affiliate Networks
          </h1>
          <p className="text-sm text-muted-foreground">
            Platforms where you source affiliate offers.
          </p>
        </div>
        {canCreate ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden /> New Network
          </Button>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by name or network ID…"
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
            Couldn&apos;t load networks: {fetchError}
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
          <NetworkIcon
            className="size-12 text-muted-foreground/40"
            aria-hidden
          />
          <div className="space-y-1">
            <p className="text-sm font-medium">No networks yet</p>
            <p className="text-sm text-muted-foreground">
              Add your first affiliate network to get started.
            </p>
          </div>
          {canCreate ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden /> New Network
            </Button>
          ) : null}
        </div>
      ) : !listApi.isLoading && data.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">
            No networks match your filters.
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
        <DataTable<Network>
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
          onRowClick={canUpdate ? (n) => setEditing(n) : undefined}
        />
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New network</DialogTitle>
            <DialogDescription>
              Platforms where you source affiliate offers.
            </DialogDescription>
          </DialogHeader>
          <NetworkForm
            key="create"
            mode="create"
            onSubmit={handleCreate}
            onCancel={() => setCreateOpen(false)}
            isSubmitting={createApi.isLoading}
          />
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit network</DialogTitle>
            <DialogDescription>{editing ? editing.name : ""}</DialogDescription>
          </DialogHeader>
          {editing ? (
            <NetworkForm
              key={`edit-${editing.id}`}
              mode="edit"
              initialValues={{
                name: editing.name,
                network_id: editing.network_id,
                url: editing.url ?? "",
                avatar_url: editing.avatar_url ?? "",
                color: editing.color ?? "",
              }}
              onSubmit={handleEdit}
              onCancel={() => setEditing(null)}
              isSubmitting={updateApi.isLoading}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Archive / Restore confirm */}
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
                ? "Archive this network?"
                : "Restore this network?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.kind === "archive"
                ? "Archived networks are hidden from the active list but their data is preserved. Existing offers will keep their network reference."
                : "Restoring a network moves it back into the active list."}
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
