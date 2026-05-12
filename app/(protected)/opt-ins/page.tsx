"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  Check,
  Copy,
  MoreHorizontal,
  Plus,
  Trash2,
  UserCheck,
} from "lucide-react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/data-table";
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
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { formatPhoneInternational } from "@/lib/phone-validation";
import { cn } from "@/lib/utils";

type BrandInfo = { id: number; name: string; color: string | null };
type ProviderInfo = { id: number; name: string; color: string | null };

type OptIn = {
  id: number;
  phone_number: string;
  brand_id: number | null;
  provider_id: number | null;
  source: string | null;
  created_at: string;
  brand: BrandInfo | null;
  provider: ProviderInfo | null;
};

type ListResponse = { data: OptIn[]; totalCount: number };
type BrandListResponse = { data: BrandInfo[] };
type ProviderListResponse = { data: ProviderInfo[] };

type Filters = {
  search: string;
  brand_id: number | null;
  provider_id: number | null;
  page: number;
  pageSize: number;
  sortBy: string;
  sortDir: "asc" | "desc";
};

const DEFAULT_FILTERS: Filters = {
  search: "",
  brand_id: null,
  provider_id: null,
  page: 0,
  pageSize: 20,
  sortBy: "created_at",
  sortDir: "desc",
};

const SEARCH_DEBOUNCE_MS = 300;
const FILTER_ALL = "__all__";

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

function Chip({ item }: { item: { name: string; color: string | null } | null }) {
  if (!item) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="size-2 rounded-full"
        style={{ backgroundColor: item.color ?? "#64748B" }}
      />
      <span className="text-sm">{item.name}</span>
    </span>
  );
}

export default function OptInsPage() {
  const { auth, can } = useAuth();

  const [filters, updateFilters, resetFilters] = usePersistedFilters<Filters>(
    "opt-ins.filters",
    DEFAULT_FILTERS,
  );
  const filtersAreDefault =
    filters.search === DEFAULT_FILTERS.search &&
    filters.brand_id === DEFAULT_FILTERS.brand_id &&
    filters.provider_id === DEFAULT_FILTERS.provider_id;

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
  const bulkDeleteApi = useApiCall<{ deleted_opt_ins: number }>();

  const [data, setData] = useState<OptIn[]>([]);
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
    if (filters.brand_id !== null) params.set("brand_id", String(filters.brand_id));
    if (filters.provider_id !== null)
      params.set("provider_id", String(filters.provider_id));

    (async () => {
      const result = await listApi.execute(
        `/api/opt-ins/list?${params.toString()}`,
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
    filters.provider_id,
    refreshTick,
    listApi.execute,
  ]);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadBrandId, setUploadBrandId] = useState<number | null>(null);
  const [uploadProviderId, setUploadProviderId] = useState<number | null>(null);
  const [uploadSource, setUploadSource] = useState("");

  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);

  const canUpload = can("opt_ins.upload");
  const canDelete = can("opt_ins.delete");

  function toggleRow(id: number) {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleUploadSuccess(summary: UploadResultSummary) {
    toast.success(
      `Added ${summary.inserted.toLocaleString()} opt-in${summary.inserted === 1 ? "" : "s"}`,
    );
    refetch();
  }

  async function handleBulkDelete() {
    const ids = Array.from(selectedRows);
    if (ids.length === 0) return;
    const result = await bulkDeleteApi.execute("/api/opt-ins/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    toast.success(`Deleted ${result.data.deleted_opt_ins} opt-ins`);
    setBulkDeleteConfirm(false);
    setSelectedRows(new Set());
    refetch();
  }

  const columns = useMemo<ColumnDef<OptIn>[]>(
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
        id: "brand",
        header: "Brand",
        enableSorting: false,
        cell: ({ row }) => <Chip item={row.original.brand} />,
      },
      {
        id: "provider",
        header: "Provider",
        enableSorting: false,
        cell: ({ row }) => <Chip item={row.original.provider} />,
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
    filters.brand_id === null ? FILTER_ALL : String(filters.brand_id);
  const providerFilterValue =
    filters.provider_id === null ? FILTER_ALL : String(filters.provider_id);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Opt-Ins</h1>
          <p className="text-sm text-muted-foreground">
            Contacts who have explicitly consented to receive messages.
          </p>
        </div>
        {canUpload ? (
          <Button
            onClick={() => {
              setUploadBrandId(null);
              setUploadProviderId(null);
              setUploadSource("");
              setUploadOpen(true);
            }}
          >
            <Plus className="size-4" aria-hidden /> Add Opt-Ins
          </Button>
        ) : null}
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
              brand_id: v === FILTER_ALL ? null : Number(v),
              page: 0,
            })
          }
        >
          <SelectTrigger className="h-9 w-[180px]">
            <SelectValue placeholder="All brands" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FILTER_ALL}>All brands</SelectItem>
            {brands.map((b) => (
              <SelectItem key={b.id} value={String(b.id)}>
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={providerFilterValue}
          onValueChange={(v) =>
            updateFilters({
              provider_id: v === FILTER_ALL ? null : Number(v),
              page: 0,
            })
          }
        >
          <SelectTrigger className="h-9 w-[180px]">
            <SelectValue placeholder="All providers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FILTER_ALL}>All providers</SelectItem>
            {providers.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {p.name}
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

      {selectedRows.size > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <div>
            <span className="font-medium">{selectedRows.size}</span> selected
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelectedRows(new Set())}>
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
            Couldn&apos;t load opt-ins: {fetchError}
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={refetch}>
            Retry
          </Button>
        </div>
      ) : !listApi.isLoading && data.length === 0 && filtersAreDefault ? (
        <div className={cn("flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-16 text-center")}>
          <UserCheck className="size-12 text-muted-foreground/40" aria-hidden />
          <div className="space-y-1">
            <p className="text-sm font-medium">No opt-ins yet</p>
            <p className="text-sm text-muted-foreground">
              Add phone numbers who have consented to receive messages.
            </p>
          </div>
          {canUpload ? (
            <Button onClick={() => setUploadOpen(true)}>
              <Plus className="size-4" aria-hidden /> Add Opt-Ins
            </Button>
          ) : null}
        </div>
      ) : !listApi.isLoading && data.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">
            No opt-ins match your filters.
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
        <DataTable<OptIn>
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

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add opt-ins</DialogTitle>
            <DialogDescription>
              Required: a brand. Optional: provider, source.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label>Brand (required)</Label>
              <div className="flex flex-wrap gap-1.5">
                {brands.map((b) => {
                  const active = uploadBrandId === b.id;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() =>
                        setUploadBrandId(active ? null : b.id)
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
              <Label>Provider (optional)</Label>
              <div className="flex flex-wrap gap-1.5">
                {providers.map((p) => {
                  const active = uploadProviderId === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() =>
                        setUploadProviderId(active ? null : p.id)
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
              <Label htmlFor="source">Source (optional)</Label>
              <Input
                id="source"
                placeholder="e.g. form submission, double opt-in"
                value={uploadSource}
                onChange={(e) => setUploadSource(e.target.value)}
              />
            </div>

            {uploadBrandId === null ? (
              <p className="text-sm text-amber-700 dark:text-amber-400">
                Select a brand to enable upload.
              </p>
            ) : (
              <PhoneUploadForm
                endpoint="/api/opt-ins/upload"
                additionalFields={{
                  brand_id: uploadBrandId,
                  provider_id: uploadProviderId,
                  source: uploadSource || undefined,
                }}
                onSuccess={handleUploadSuccess}
                onCancel={() => setUploadOpen(false)}
                submitLabel="Add opt-ins"
                successLabel="Opt-ins added"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={bulkDeleteConfirm} onOpenChange={setBulkDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedRows.size} opt-in{selectedRows.size === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected records. Cannot be undone.
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

      {isAuthLoading ? (
        <p className="sr-only" aria-live="polite">
          Loading…
        </p>
      ) : null}
    </div>
  );
}
