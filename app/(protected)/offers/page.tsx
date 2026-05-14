"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  ArchiveRestore,
  Archive as ArchiveIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  ShoppingBag,
} from "lucide-react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import { OfferForm, type OfferFormValues } from "@/components/offers/offer-form";
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
import { isEntityAvailable } from "@/lib/feature-flags";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { cn } from "@/lib/utils";

type Network = {
  id: number;
  name: string;
  avatar_url: string | null;
  color: string | null;
};

type Offer = {
  id: number;
  offer_id: string;
  name: string;
  postfix: string | null;
  base_url: string | null;
  network_id: number | null;
  payout_model: "cpa" | "revshare";
  payout_cpa: string | null;
  payout_revshare: string | null;
  sales_pages: { label: string; url: string }[];
  avatar_url: string | null;
  color: string | null;
  status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
  org_id: string;
  network: Network | null;
};

type ListResponse = {
  data: Offer[];
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
const NETWORK_FILTER_NONE = "__none__";

function OfferCell({ offer }: { offer: Offer }) {
  const initial = offer.name.charAt(0).toUpperCase() || "?";
  return (
    <div className="flex items-center gap-3">
      <div
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white"
        style={{ backgroundColor: offer.color ?? "#64748B" }}
      >
        {initial}
      </div>
      <div className="min-w-0">
        <div className="truncate font-medium">{offer.name}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {offer.offer_id}
        </div>
      </div>
    </div>
  );
}

function NetworkCell({ network }: { network: Network | null }) {
  if (!network) {
    return <span className="text-muted-foreground">—</span>;
  }
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

function PayoutCell({ offer }: { offer: Offer }) {
  if (offer.payout_model === "cpa") {
    const v = offer.payout_cpa ? Number(offer.payout_cpa) : null;
    return (
      <span className="text-sm">
        {v !== null
          ? `$${v.toFixed(2)} CPA`
          : <span className="text-muted-foreground">— CPA</span>}
      </span>
    );
  }
  const v = offer.payout_revshare ? Number(offer.payout_revshare) : null;
  return (
    <span className="text-sm">
      {v !== null
        ? `${v.toFixed(2)}% RevShare`
        : <span className="text-muted-foreground">— RevShare</span>}
    </span>
  );
}

function StatusBadge({ status }: { status: Offer["status"] }) {
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

export default function OffersPage() {
  const { auth, can } = useAuth();

  const [filters, updateFilters, resetFilters] = usePersistedFilters<Filters>(
    "offers.filters",
    DEFAULT_FILTERS,
  );
  const filtersAreDefault =
    filters.search === DEFAULT_FILTERS.search &&
    filters.showArchived === DEFAULT_FILTERS.showArchived &&
    filters.networkFilter === DEFAULT_FILTERS.networkFilter;

  // Search debounce
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
  const createApi = useApiCall<Offer>();
  const updateApi = useApiCall<Offer>();
  const archiveApi = useApiCall<Offer>();
  const restoreApi = useApiCall<Offer>();
  const networksApi = useApiCall<NetworksListResponse>();

  const [data, setData] = useState<Offer[]>([]);
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
      params.set("network_id", String(filters.networkFilter));
    }

    (async () => {
      const result = await listApi.execute(
        `/api/offers/list?${params.toString()}`,
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
  const [editing, setEditing] = useState<Offer | null>(null);
  const [confirming, setConfirming] = useState<
    | { kind: "archive"; offer: Offer }
    | { kind: "restore"; offer: Offer }
    | null
  >(null);

  const canCreate = can("offers.create");
  const canUpdate = can("offers.update");
  const canArchive = can("offers.archive");
  const canRestore = can("offers.restore");

  async function handleCreate(values: OfferFormValues) {
    const result = await createApi.execute("/api/offers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't create offer");
      return;
    }
    toast.success("Offer created");
    setCreateOpen(false);
    refetch();
  }

  async function handleEdit(values: OfferFormValues) {
    if (!editing) return;
    const { offer_id: _omit, ...patch } = values;
    const result = await updateApi.execute(`/api/offers/${editing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't save offer");
      return;
    }
    toast.success("Offer saved");
    setEditing(null);
    refetch();
  }

  async function handleConfirm() {
    if (!confirming) return;
    const isArchive = confirming.kind === "archive";
    const api = isArchive ? archiveApi : restoreApi;
    const result = await api.execute(
      `/api/offers/${confirming.offer.id}/${isArchive ? "archive" : "restore"}`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(
        result,
        isArchive ? "Couldn't archive offer" : "Couldn't restore offer",
      );
      return;
    }
    toast.success(isArchive ? "Offer archived" : "Offer restored");
    setConfirming(null);
    refetch();
  }

  const columns = useMemo<ColumnDef<Offer>[]>(
    () => [
      {
        id: "name",
        header: "Offer",
        cell: ({ row }) => <OfferCell offer={row.original} />,
        enableSorting: true,
      },
      {
        id: "network",
        header: "Network",
        cell: ({ row }) => <NetworkCell network={row.original.network} />,
        enableSorting: false,
      },
      {
        id: "payout_model",
        header: "Payout",
        cell: ({ row }) => <PayoutCell offer={row.original} />,
        enableSorting: true,
      },
      {
        id: "sales_pages",
        header: "Sales pages",
        cell: ({ row }) => {
          const n = row.original.sales_pages?.length ?? 0;
          if (n === 0) return <span className="text-muted-foreground">—</span>;
          return (
            <Badge variant="secondary">
              {n} {n === 1 ? "page" : "pages"}
            </Badge>
          );
        },
        enableSorting: false,
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
          const offer = row.original;
          const showEdit = canUpdate;
          const showArchive = offer.status === "active" && canArchive;
          const showRestore = offer.status === "archived" && canRestore;
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
                    <DropdownMenuItem onSelect={() => setEditing(offer)}>
                      <Pencil className="size-4" aria-hidden /> Edit
                    </DropdownMenuItem>
                  ) : null}
                  {showArchive ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirming({ kind: "archive", offer })
                      }
                    >
                      <ArchiveIcon className="size-4" aria-hidden /> Archive
                    </DropdownMenuItem>
                  ) : null}
                  {showRestore ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirming({ kind: "restore", offer })
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
          <h1 className="text-2xl font-semibold tracking-tight">Offers</h1>
          <p className="text-sm text-muted-foreground">
            Affiliate products you promote through campaigns.
          </p>
        </div>
        {canCreate ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden /> New Offer
          </Button>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by name or offer ID…"
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
          onValueChange={(v) => {
            if (v === NETWORK_FILTER_ALL) {
              updateFilters({ networkFilter: null, page: 0 });
            } else if (v === NETWORK_FILTER_NONE) {
              // Not yet supported by the API as a distinct filter; treat as "all"
              // to avoid silently mis-filtering. Reserved value for future use.
              updateFilters({ networkFilter: null, page: 0 });
            } else {
              updateFilters({ networkFilter: Number(v), page: 0 });
            }
          }}
          disabled={!networksAvailable}
        >
          <SelectTrigger className="h-9 w-[200px]">
            <SelectValue
              placeholder={
                !networksAvailable
                  ? "Networks not yet available — see Step 5.2"
                  : "All networks"
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
            Couldn&apos;t load offers: {fetchError}
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
          <ShoppingBag
            className="size-12 text-muted-foreground/40"
            aria-hidden
          />
          <div className="space-y-1">
            <p className="text-sm font-medium">No offers yet</p>
            <p className="text-sm text-muted-foreground">
              Create your first offer to get started.
            </p>
          </div>
          {canCreate ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden /> New Offer
            </Button>
          ) : null}
        </div>
      ) : !listApi.isLoading && data.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">
            No offers match your filters.
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
        <DataTable<Offer>
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
          onRowClick={canUpdate ? (o) => setEditing(o) : undefined}
        />
      )}

      {/* Create dialog */}
      <FormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        className="max-h-[90vh] overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>New offer</DialogTitle>
          <DialogDescription>
            Affiliate products you promote through campaigns.
          </DialogDescription>
        </DialogHeader>
        <OfferForm
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
        className="max-h-[90vh] overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>Edit offer</DialogTitle>
          <DialogDescription>{editing ? editing.name : ""}</DialogDescription>
        </DialogHeader>
        {editing ? (
          <OfferForm
            key={`edit-${editing.id}`}
            mode="edit"
            initialValues={{
              name: editing.name,
              offer_id: editing.offer_id,
              postfix: editing.postfix ?? "",
              base_url: editing.base_url ?? "",
              // Pre-migration rows may have null network_id; the form
              // treats undefined as "untouched" so the user is forced to
              // pick before save.
              network_id: editing.network_id ?? undefined,
              payout_model: editing.payout_model,
              payout_cpa:
                editing.payout_cpa != null
                  ? Number(editing.payout_cpa)
                  : undefined,
              payout_revshare:
                editing.payout_revshare != null
                  ? Number(editing.payout_revshare)
                  : undefined,
              sales_pages: editing.sales_pages ?? [],
              avatar_url: editing.avatar_url ?? "",
              color: editing.color ?? "",
            }}
            onSubmit={handleEdit}
            onCancel={() => setEditing(null)}
            isSubmitting={updateApi.isLoading}
          />
        ) : null}
      </FormDialog>

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
                ? "Archive this offer?"
                : "Restore this offer?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.kind === "archive"
                ? "Archived offers are hidden from the active list but their data is preserved. You can restore them later."
                : "Restoring an offer moves it back into the active list."}
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
