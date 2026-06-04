"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Check,
  Copy,
  Inbox,
  MoreHorizontal,
  Plus,
  Trash2,
  UserMinus,
} from "lucide-react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/data-table";
import { ExportButton } from "@/components/export-button";
import {
  PhoneUploadForm,
  type UploadResultSummary,
} from "@/components/phone-upload-form";
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
import { toastApiError } from "@/lib/api/toast-error";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { formatPhoneInternational } from "@/lib/phone-validation";
import { cn } from "@/lib/utils";

type BrandInfo = { id: number; name: string; color: string | null };
type ProviderInfo = { id: number; name: string; color: string | null };

type CampaignRef = {
  id: number;
  name: string | null;
  human_id: string | null;
  tracking_id: string | null;
};

type OptOut = {
  id: number;
  phone_number: string;
  source: string | null;
  created_at: string;
  brands: BrandInfo[];
  providers: ProviderInfo[];
  campaign: CampaignRef | null;
};

type ListResponse = {
  data: OptOut[];
  totalCount: number;
};

type BrandListResponse = { data: BrandInfo[] };
type ProviderListResponse = { data: ProviderInfo[] };

type Filters = {
  search: string;
  brand_id: number | null;
  page: number;
  pageSize: number;
  sortBy: string;
  sortDir: "asc" | "desc";
};

const DEFAULT_FILTERS: Filters = {
  search: "",
  brand_id: null,
  page: 0,
  pageSize: 20,
  sortBy: "created_at",
  sortDir: "desc",
};

const SEARCH_DEBOUNCE_MS = 300;
const BRAND_FILTER_ALL = "__all__";

function PhoneCell({ phone }: { phone: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(phone);
          setCopied(true);
          setTimeout(() => setCopied(false), 1000);
        } catch {}
      }}
      className="inline-flex items-center gap-1.5 font-mono text-sm hover:text-foreground"
    >
      <span>{formatPhoneInternational(phone)}</span>
      {copied ? (
        <Check className="size-3 text-emerald-600" aria-hidden />
      ) : (
        <Copy className="size-3 opacity-40" aria-hidden />
      )}
    </button>
  );
}

function ChipList({
  items,
  emptyLabel = "—",
}: {
  items: { id: number; name: string; color: string | null }[];
  emptyLabel?: string;
}) {
  if (items.length === 0)
    return <span className="text-muted-foreground">{emptyLabel}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((b) => (
        <span
          key={b.id}
          className="inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-xs"
        >
          <span
            className="size-2 rounded-full"
            style={{ backgroundColor: b.color ?? "#64748B" }}
          />
          {b.name}
        </span>
      ))}
    </div>
  );
}

export default function OptOutsPage() {
  const { auth, can } = useAuth();

  const [filters, updateFilters, resetFilters] = usePersistedFilters<Filters>(
    "opt-outs.filters",
    DEFAULT_FILTERS,
  );
  const filtersAreDefault =
    filters.search === DEFAULT_FILTERS.search &&
    filters.brand_id === DEFAULT_FILTERS.brand_id;

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
  const brandsApi = useApiCall<BrandListResponse>();
  const providersApi = useApiCall<ProviderListResponse>();
  const bulkDeleteApi = useApiCall<{ deleted_opt_outs: number }>();
  const bulkDeleteByBrandApi = useApiCall<{
    deleted_junctions: number;
    deleted_opt_outs: number;
  }>();
  const pollApi = useApiCall<{
    credentials_polled: number;
    fetched: number;
    new: number;
    suppressed: number;
  }>();

  const [data, setData] = useState<OptOut[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refetch = useCallback(() => setRefreshTick((n) => n + 1), []);

  const [brands, setBrands] = useState<BrandInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  useEffect(() => {
    (async () => {
      const r = await brandsApi.execute("/api/brands/list?pageSize=100");
      if (r.ok) setBrands(r.data.data);
    })();
  }, [brandsApi.execute]);
  useEffect(() => {
    (async () => {
      const r = await providersApi.execute("/api/providers/list?pageSize=100");
      if (r.ok) setProviders(r.data.data);
    })();
  }, [providersApi.execute]);

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
    if (filters.brand_id !== null)
      params.set("brand_id", String(filters.brand_id));

    (async () => {
      const result = await listApi.execute(
        `/api/opt-outs/list?${params.toString()}`,
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
    filters.brand_id,
    refreshTick,
    listApi.execute,
  ]);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [selectedBrandIds, setSelectedBrandIds] = useState<number[]>([]);
  const [selectedProviderIds, setSelectedProviderIds] = useState<number[]>([]);
  const [source, setSource] = useState("");

  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [deleteByBrandOpen, setDeleteByBrandOpen] = useState(false);
  const [deleteByBrandId, setDeleteByBrandId] = useState<number | null>(null);

  const canUpload = can("opt_outs.upload");
  const canDelete = can("opt_outs.delete");

  function toggleRow(id: number) {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function clearSelection() {
    setSelectedRows(new Set());
  }

  async function handleUploadSuccess(summary: UploadResultSummary) {
    toast.success(
      `Added ${summary.inserted.toLocaleString()} opt-out${summary.inserted === 1 ? "" : "s"}`,
    );
    refetch();
  }

  async function handlePoll() {
    const result = await pollApi.execute("/api/opt-outs/poll", {
      method: "POST",
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't poll for opt-outs");
      return;
    }
    const { suppressed, fetched, credentials_polled } = result.data;
    if (credentials_polled === 0) {
      toast.message("No TextHub API keys to poll", {
        description: "Add an API-capable provider credential first.",
      });
    } else if (suppressed > 0) {
      toast.success(
        `Suppressed ${suppressed.toLocaleString()} from STOP repl${suppressed === 1 ? "y" : "ies"}`,
        { description: `Polled ${fetched} inbound message${fetched === 1 ? "" : "s"}.` },
      );
      refetch();
    } else {
      toast.message("No new opt-outs", {
        description: `Polled ${fetched} inbound message${fetched === 1 ? "" : "s"} across ${credentials_polled} inbox${credentials_polled === 1 ? "" : "es"}.`,
      });
    }
  }

  async function handleBulkDelete() {
    const ids = Array.from(selectedRows);
    if (ids.length === 0) return;
    const result = await bulkDeleteApi.execute("/api/opt-outs/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    toast.success(`Deleted ${result.data.deleted_opt_outs} opt-outs`);
    setBulkDeleteConfirm(false);
    clearSelection();
    refetch();
  }

  async function handleDeleteByBrand() {
    if (deleteByBrandId === null) return;
    const result = await bulkDeleteByBrandApi.execute(
      "/api/opt-outs/bulk-delete-by-brand",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand_id: deleteByBrandId }),
      },
    );
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    toast.success(
      `Removed brand scope from ${result.data.deleted_junctions} opt-outs; cleared ${result.data.deleted_opt_outs} orphaned records`,
    );
    setDeleteByBrandOpen(false);
    setDeleteByBrandId(null);
    refetch();
  }

  const columns = useMemo<ColumnDef<OptOut>[]>(
    () => [
      {
        id: "select",
        header: () => null,
        enableSorting: false,
        cell: ({ row }) => (
          <input
            type="checkbox"
            checked={selectedRows.has(row.original.id)}
            onClick={(e) => e.stopPropagation()}
            onChange={() => toggleRow(row.original.id)}
            aria-label="Select row"
            className="size-4 cursor-pointer"
          />
        ),
      },
      {
        id: "phone_number",
        header: "Phone",
        cell: ({ row }) => <PhoneCell phone={row.original.phone_number} />,
        enableSorting: true,
      },
      {
        id: "brands",
        header: "Brands",
        enableSorting: false,
        cell: ({ row }) => <ChipList items={row.original.brands} />,
      },
      {
        id: "providers",
        header: "Providers",
        enableSorting: false,
        cell: ({ row }) => <ChipList items={row.original.providers} />,
      },
      {
        id: "source",
        header: "Source",
        cell: ({ row }) =>
          row.original.source ? (
            <span className="text-xs text-muted-foreground">
              {row.original.source}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
        enableSorting: true,
      },
      {
        id: "campaign",
        header: "Campaign",
        enableSorting: false,
        cell: ({ row }) => {
          const c = row.original.campaign;
          if (!c)
            return <span className="text-muted-foreground">—</span>;
          const label =
            c.name ?? c.human_id ?? c.tracking_id ?? `Campaign #${c.id}`;
          return (
            <Link
              href={`/campaigns/${c.id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-primary underline-offset-2 hover:underline"
            >
              {label}
            </Link>
          );
        },
      },
      {
        id: "created_at",
        header: "Created",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {formatCampaignDateTime(row.original.created_at)}
          </span>
        ),
        enableSorting: true,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => {
          if (!canDelete) return null;
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
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => {
                      setSelectedRows(new Set([row.original.id]));
                      setBulkDeleteConfirm(true);
                    }}
                  >
                    <Trash2 className="size-4" aria-hidden /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      },
    ],
    [canDelete, selectedRows],
  );

  const isAuthLoading = !auth;
  const brandFilterValue =
    filters.brand_id === null ? BRAND_FILTER_ALL : String(filters.brand_id);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Opt-Outs</h1>
          <p className="text-sm text-muted-foreground">
            Contacts excluded from sends, scoped to brands and/or providers.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canUpload ? (
            <Button
              variant="outline"
              onClick={() => void handlePoll()}
              disabled={pollApi.isLoading}
              title="Pull inbound STOP replies from TextHub and suppress them"
            >
              <Inbox className="size-4" aria-hidden />
              {pollApi.isLoading ? "Polling…" : "Poll opt-outs"}
            </Button>
          ) : null}
          {canDelete ? (
            <Button
              variant="outline"
              onClick={() => setDeleteByBrandOpen(true)}
            >
              Bulk delete by brand
            </Button>
          ) : null}
          {canUpload ? (
            <Button
              onClick={() => {
                setSelectedBrandIds([]);
                setSelectedProviderIds([]);
                setSource("");
                setUploadOpen(true);
              }}
            >
              <Plus className="size-4" aria-hidden /> Add Opt-Outs
            </Button>
          ) : null}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by phone…"
          className="h-9 w-full max-w-sm"
        />
        <Select
          value={brandFilterValue}
          onValueChange={(v) =>
            updateFilters({
              brand_id: v === BRAND_FILTER_ALL ? null : Number(v),
              page: 0,
            })
          }
        >
          <SelectTrigger className="h-9 w-[200px]">
            <SelectValue placeholder="All brands" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={BRAND_FILTER_ALL}>All brands</SelectItem>
            {brands.map((b) => (
              <SelectItem key={b.id} value={String(b.id)}>
                {b.name}
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
        <div className="ml-auto">
          <ExportButton
            endpoint="/api/opt-outs/export"
            permission="opt_outs.view"
            filenamePrefix="opt-outs"
            queryParams={{
              search: filters.search || undefined,
              brand_id: filters.brand_id,
              sortBy: filters.sortBy,
              sortDir: filters.sortDir,
            }}
            disabledIfEmpty={totalCount}
          />
        </div>
      </div>

      {selectedRows.size > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <div>
            <span className="font-medium">{selectedRows.size}</span> selected
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={clearSelection}>
              Clear
            </Button>
            {canDelete ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setBulkDeleteConfirm(true)}
              >
                <Trash2 className="size-4" aria-hidden /> Delete selected
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {fetchError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">
            Couldn&apos;t load opt-outs: {fetchError}
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
          <UserMinus
            className="size-12 text-muted-foreground/40"
            aria-hidden
          />
          <div className="space-y-1">
            <p className="text-sm font-medium">No opt-outs yet</p>
            <p className="text-sm text-muted-foreground">
              Add phone numbers excluded from sends.
            </p>
          </div>
          {canUpload ? (
            <Button
              onClick={() => {
                setSelectedBrandIds([]);
                setUploadOpen(true);
              }}
            >
              <Plus className="size-4" aria-hidden /> Add Opt-Outs
            </Button>
          ) : null}
        </div>
      ) : !listApi.isLoading && data.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">
            No opt-outs match your filters.
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
        <DataTable<OptOut>
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
        />
      )}

      <FormDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        className="max-h-[90vh] overflow-y-auto sm:max-w-xl"
      >
          <DialogHeader>
            <DialogTitle>Add opt-outs</DialogTitle>
            <DialogDescription>
              Required: at least one brand. Optional: providers, source.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label>
                Brands
                <span aria-hidden className="text-destructive ml-0.5">*</span>
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {brands.map((b) => {
                  const active = selectedBrandIds.includes(b.id);
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() =>
                        setSelectedBrandIds((prev) =>
                          prev.includes(b.id)
                            ? prev.filter((id) => id !== b.id)
                            : [...prev, b.id],
                        )
                      }
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs",
                        active
                          ? "border-foreground bg-foreground text-background"
                          : "bg-background hover:bg-muted",
                      )}
                    >
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: b.color ?? "#64748B" }}
                      />
                      {b.name}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-2">
              <Label>Providers</Label>
              <div className="flex flex-wrap gap-1.5">
                {providers.map((p) => {
                  const active = selectedProviderIds.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() =>
                        setSelectedProviderIds((prev) =>
                          prev.includes(p.id)
                            ? prev.filter((id) => id !== p.id)
                            : [...prev, p.id],
                        )
                      }
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs",
                        active
                          ? "border-foreground bg-foreground text-background"
                          : "bg-background hover:bg-muted",
                      )}
                    >
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: p.color ?? "#64748B" }}
                      />
                      {p.name}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="source">Source</Label>
              <Input
                id="source"
                placeholder="e.g. STOP reply, manual, API"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
            </div>

            {selectedBrandIds.length === 0 ? (
              <p className="text-sm text-amber-700 dark:text-amber-400">
                Select at least one brand to enable upload.
              </p>
            ) : (
              <PhoneUploadForm
                endpoint="/api/opt-outs/upload"
                additionalFields={{
                  brand_ids: selectedBrandIds,
                  provider_ids: selectedProviderIds,
                  source: source || undefined,
                }}
                onSuccess={handleUploadSuccess}
                onCancel={() => setUploadOpen(false)}
                submitLabel="Add opt-outs"
                successLabel="Opt-outs added"
                enableContactGroups
              />
            )}
          </div>
      </FormDialog>

      <AlertDialog open={bulkDeleteConfirm} onOpenChange={setBulkDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedRows.size} opt-out
              {selectedRows.size === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected records and their brand /
              provider scopes. Cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleteApi.isLoading}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleBulkDelete();
              }}
              disabled={bulkDeleteApi.isLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <FormDialog
        open={deleteByBrandOpen}
        onOpenChange={setDeleteByBrandOpen}
        className="sm:max-w-md"
      >
          <DialogHeader>
            <DialogTitle>Bulk delete by brand</DialogTitle>
            <DialogDescription>
              Removes the chosen brand from every opt-out it appears on. Opt-outs
              with no remaining brand scope are deleted entirely.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Label htmlFor="delete-by-brand">Brand to remove</Label>
            <Select
              value={deleteByBrandId !== null ? String(deleteByBrandId) : ""}
              onValueChange={(v) => setDeleteByBrandId(Number(v))}
            >
              <SelectTrigger id="delete-by-brand">
                <SelectValue placeholder="Select a brand" />
              </SelectTrigger>
              <SelectContent>
                {brands.map((b) => (
                  <SelectItem key={b.id} value={String(b.id)}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => {
                  setDeleteByBrandOpen(false);
                  setDeleteByBrandId(null);
                }}
                disabled={bulkDeleteByBrandApi.isLoading}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={
                  deleteByBrandId === null || bulkDeleteByBrandApi.isLoading
                }
                onClick={handleDeleteByBrand}
              >
                Remove brand
              </Button>
            </div>
          </div>
      </FormDialog>

      {isAuthLoading ? (
        <p className="sr-only" aria-live="polite">
          Loading…
        </p>
      ) : null}
    </div>
  );
}
