"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  ArchiveRestore,
  Archive as ArchiveIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  Tag,
} from "lucide-react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import { BrandForm, type BrandFormValues } from "@/components/brands/brand-form";
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
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { cn } from "@/lib/utils";

type Brand = {
  id: number;
  brand_id: string;
  name: string;
  short_link_base: string | null;
  avatar_url: string | null;
  color: string | null;
  status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
  org_id: string;
};

type ListResponse = {
  data: Brand[];
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

function BrandCell({ brand }: { brand: Brand }) {
  const initial = brand.name.charAt(0).toUpperCase() || "?";
  return (
    <div className="flex items-center gap-3">
      <div
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white"
        style={{ backgroundColor: brand.color ?? "#64748B" }}
      >
        {initial}
      </div>
      <div className="min-w-0">
        <div className="truncate font-medium">{brand.name}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {brand.brand_id}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Brand["status"] }) {
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

export default function BrandsPage() {
  const { auth, can } = useAuth();

  const [filters, updateFilters, resetFilters] = usePersistedFilters<Filters>(
    "brands.filters",
    DEFAULT_FILTERS,
  );
  const filtersAreDefault =
    filters.search === DEFAULT_FILTERS.search &&
    filters.showArchived === DEFAULT_FILTERS.showArchived;

  // Local search box state — debounced to avoid one fetch per keystroke.
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

  const [data, setData] = useState<Brand[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const refetch = useCallback(() => setRefreshTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setFetchError(null);

    const params = new URLSearchParams({
      page: String(filters.page),
      pageSize: String(filters.pageSize),
      sortBy: filters.sortBy,
      sortDir: filters.sortDir,
    });
    if (filters.search) params.set("search", filters.search);
    if (filters.showArchived) params.set("showArchived", "true");

    fetch(`/api/brands/list?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `Request failed (${r.status})`);
        }
        return (await r.json()) as ListResponse;
      })
      .then((body) => {
        if (cancelled) return;
        setData(body.data);
        setTotalCount(body.totalCount);
      })
      .catch((e) => {
        if (cancelled) return;
        setFetchError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoading(false);
      });

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
  ]);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Brand | null>(null);
  const [confirming, setConfirming] = useState<
    | { kind: "archive"; brand: Brand }
    | { kind: "restore"; brand: Brand }
    | null
  >(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const canCreate = can("brands.create");
  const canUpdate = can("brands.update");
  const canArchive = can("brands.archive");
  const canRestore = can("brands.restore");

  async function handleCreate(values: BrandFormValues) {
    setIsSubmitting(true);
    try {
      const r = await fetch("/api/brands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast.error(body.error ?? "Couldn't create brand");
        return;
      }
      toast.success("Brand created");
      setCreateOpen(false);
      refetch();
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleEdit(values: BrandFormValues) {
    if (!editing) return;
    setIsSubmitting(true);
    try {
      // Strip brand_id from the patch (it can't change and PATCH would re-validate it).
      const { brand_id: _omit, ...patch } = values;
      const r = await fetch(`/api/brands/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast.error(body.error ?? "Couldn't save brand");
        return;
      }
      toast.success("Brand saved");
      setEditing(null);
      refetch();
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleConfirm() {
    if (!confirming) return;
    setConfirmBusy(true);
    try {
      const action = confirming.kind === "archive" ? "archive" : "restore";
      const r = await fetch(
        `/api/brands/${confirming.brand.id}/${action}`,
        { method: "POST" },
      );
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast.error(body.error ?? `Couldn't ${action} brand`);
        return;
      }
      toast.success(
        action === "archive" ? "Brand archived" : "Brand restored",
      );
      setConfirming(null);
      refetch();
    } finally {
      setConfirmBusy(false);
    }
  }

  const columns = useMemo<ColumnDef<Brand>[]>(
    () => [
      {
        id: "name",
        header: "Brand",
        cell: ({ row }) => <BrandCell brand={row.original} />,
        enableSorting: true,
      },
      {
        id: "short_link_base",
        header: "Short link base",
        cell: ({ row }) =>
          row.original.short_link_base ? (
            <span className="font-mono text-xs">
              {row.original.short_link_base}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
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
          const brand = row.original;
          const showEdit = canUpdate;
          const showArchive = brand.status === "active" && canArchive;
          const showRestore = brand.status === "archived" && canRestore;
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
                    <DropdownMenuItem onSelect={() => setEditing(brand)}>
                      <Pencil className="size-4" aria-hidden /> Edit
                    </DropdownMenuItem>
                  ) : null}
                  {showArchive ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirming({ kind: "archive", brand })
                      }
                    >
                      <ArchiveIcon className="size-4" aria-hidden /> Archive
                    </DropdownMenuItem>
                  ) : null}
                  {showRestore ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirming({ kind: "restore", brand })
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

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Brands</h1>
          <p className="text-sm text-muted-foreground">
            Brands group your campaigns and creatives.
          </p>
        </div>
        {canCreate ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden /> New Brand
          </Button>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by name or brand ID…"
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
            Couldn&apos;t load brands: {fetchError}
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
      ) : !isLoading && data.length === 0 && filtersAreDefault ? (
        <div
          className={cn(
            "flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-16 text-center",
          )}
        >
          <Tag className="size-12 text-muted-foreground/40" aria-hidden />
          <div className="space-y-1">
            <p className="text-sm font-medium">No brands yet</p>
            <p className="text-sm text-muted-foreground">
              Create your first brand to get started.
            </p>
          </div>
          {canCreate ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden /> New Brand
            </Button>
          ) : null}
        </div>
      ) : !isLoading && data.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">
            No brands match your filters.
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
        <DataTable<Brand>
          data={data}
          columns={columns}
          isLoading={isLoading}
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
          onRowClick={
            canUpdate
              ? (b) => setEditing(b)
              : undefined
          }
        />
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New brand</DialogTitle>
            <DialogDescription>
              Brands group your campaigns and creatives.
            </DialogDescription>
          </DialogHeader>
          <BrandForm
            key="create"
            mode="create"
            onSubmit={handleCreate}
            onCancel={() => setCreateOpen(false)}
            isSubmitting={isSubmitting}
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
            <DialogTitle>Edit brand</DialogTitle>
            <DialogDescription>
              {editing ? editing.name : ""}
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <BrandForm
              key={`edit-${editing.id}`}
              mode="edit"
              initialValues={{
                name: editing.name,
                brand_id: editing.brand_id,
                short_link_base: editing.short_link_base ?? "",
                avatar_url: editing.avatar_url ?? "",
                color: editing.color ?? "",
              }}
              onSubmit={handleEdit}
              onCancel={() => setEditing(null)}
              isSubmitting={isSubmitting}
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
                ? "Archive this brand?"
                : "Restore this brand?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.kind === "archive"
                ? "Archived brands are hidden from the active list but their data is preserved. You can restore them later."
                : "Restoring a brand moves it back into the active list."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirmBusy}>
              Cancel
            </AlertDialogCancel>
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
