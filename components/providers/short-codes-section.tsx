"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArchiveRestore,
  Archive as ArchiveIcon,
  Check,
  Copy,
  MoreHorizontal,
  Pencil,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/data-table";
import {
  ShortCodeForm,
  type ShortCodeFormValues,
} from "@/components/providers/short-code-form";
import { useAuth } from "@/components/protected/auth-context";
import {
  StatusDropdown,
  type StatusOption,
} from "@/components/status-dropdown";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FormDialog } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { cn } from "@/lib/utils";

type ShortCodeStatus = "active" | "suspended" | "blocked" | "archived";

type ShortCode = {
  id: number;
  org_id: string;
  provider_id: number;
  brand_id: number | null;
  short_code: string;
  cost_per_sms: string;
  status: ShortCodeStatus;
  archived_at: string | null;
  created_at: string;
  brand: {
    id: number;
    name: string;
    color: string | null;
    avatar_url: string | null;
  } | null;
};

type ShortCodesListResponse = { data: ShortCode[] };

type ShortCodesFilters = {
  search: string;
  statuses: ShortCodeStatus[];
  sortBy: string;
  sortDir: "asc" | "desc";
};

const DEFAULT_FILTERS: ShortCodesFilters = {
  search: "",
  statuses: ["active", "suspended", "blocked"],
  sortBy: "created_at",
  sortDir: "desc",
};

const ALL_STATUSES: ShortCodeStatus[] = [
  "active",
  "suspended",
  "blocked",
  "archived",
];

const STATUS_OPTIONS: StatusOption<"active" | "suspended" | "blocked">[] = [
  { value: "active", label: "Active", color: "green" },
  { value: "suspended", label: "Suspended", color: "amber" },
  { value: "blocked", label: "Blocked", color: "red" },
];

const SEARCH_DEBOUNCE_MS = 300;

function ShortCodeCell({ shortCode }: { shortCode: ShortCode }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(shortCode.short_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1000);
    } catch {
      // ignore
    }
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void copy();
      }}
      className="inline-flex items-center gap-1.5 font-mono text-sm hover:text-foreground"
    >
      <span>{shortCode.short_code}</span>
      {copied ? (
        <Check className="size-3 text-emerald-600" aria-hidden />
      ) : (
        <Copy className="size-3 opacity-40" aria-hidden />
      )}
    </button>
  );
}

function BrandCell({ brand }: { brand: ShortCode["brand"] }) {
  if (!brand) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="size-3 rounded-full"
        style={{ backgroundColor: brand.color ?? "#64748B" }}
      />
      <span className="text-sm">{brand.name}</span>
    </span>
  );
}

export function ProviderShortCodesSection({
  providerId,
  providerName,
}: {
  providerId: number;
  providerName: string;
}) {
  const { can } = useAuth();

  const listApi = useApiCall<ShortCodesListResponse>();
  const createApi = useApiCall<ShortCode>();
  const updateApi = useApiCall<ShortCode>();
  const statusApi = useApiCall<ShortCode>();
  const archiveApi = useApiCall<ShortCode>();
  const restoreApi = useApiCall<ShortCode>();

  const canCreate = can("provider_short_codes.create");
  const canUpdate = can("provider_short_codes.update");
  const canArchive = can("provider_short_codes.archive");
  const canRestore = can("provider_short_codes.restore");

  const [filters, updateFilters, resetFilters] =
    usePersistedFilters<ShortCodesFilters>(
      `provider-short-codes.${providerId}.filters`,
      DEFAULT_FILTERS,
    );
  const [searchInput, setSearchInput] = useState(filters.search);
  useEffect(() => {
    setSearchInput(filters.search);
  }, [filters.search]);
  useEffect(() => {
    if (searchInput === filters.search) return;
    const t = setTimeout(() => {
      updateFilters({ search: searchInput });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput, filters.search, updateFilters]);

  const [shortCodes, setShortCodes] = useState<ShortCode[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refetch = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!Number.isInteger(providerId) || providerId <= 0) return;
    let cancelled = false;
    setListError(null);

    const sp = new URLSearchParams({
      status: filters.statuses.join(","),
      sortBy: filters.sortBy,
      sortDir: filters.sortDir,
    });
    if (filters.search) sp.set("search", filters.search);

    (async () => {
      const result = await listApi.execute(
        `/api/providers/${providerId}/short-codes?${sp.toString()}`,
      );
      if (cancelled) return;
      if (result.ok) setShortCodes(result.data.data);
      else setListError(result.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    providerId,
    filters.statuses,
    filters.sortBy,
    filters.sortDir,
    filters.search,
    tick,
    listApi.execute,
  ]);

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<ShortCode | null>(null);
  const [confirming, setConfirming] = useState<
    { kind: "archive" | "restore"; shortCode: ShortCode } | null
  >(null);

  async function handleAdd(values: ShortCodeFormValues) {
    const result = await createApi.execute(
      `/api/providers/${providerId}/short-codes`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't add short code");
      return;
    }
    toast.success("Short code added");
    setAddOpen(false);
    refetch();
  }

  async function handleEdit(values: ShortCodeFormValues) {
    if (!editing) return;
    const patch = {
      cost_per_sms: values.cost_per_sms,
      brand_id: values.brand_id,
    };
    const result = await updateApi.execute(
      `/api/providers/${providerId}/short-codes/${editing.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't save short code");
      return;
    }
    toast.success("Short code saved");
    setEditing(null);
    refetch();
  }

  async function handleStatusChange(
    shortCode: ShortCode,
    next: "active" | "suspended" | "blocked",
  ) {
    const result = await statusApi.execute(
      `/api/providers/${providerId}/short-codes/${shortCode.id}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't update short code status");
      return;
    }
    toast.success(`Short code marked ${next}`);
    refetch();
  }

  async function handleConfirm() {
    if (!confirming) return;
    const isArchive = confirming.kind === "archive";
    const api = isArchive ? archiveApi : restoreApi;
    const result = await api.execute(
      `/api/providers/${providerId}/short-codes/${confirming.shortCode.id}/${isArchive ? "archive" : "restore"}`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    toast.success(isArchive ? "Short code archived" : "Short code restored");
    setConfirming(null);
    refetch();
  }

  const columns = useMemo<ColumnDef<ShortCode>[]>(
    () => [
      {
        id: "short_code",
        header: "Short Code",
        cell: ({ row }) => <ShortCodeCell shortCode={row.original} />,
        enableSorting: true,
      },
      {
        id: "brand",
        header: "Brand",
        enableSorting: false,
        cell: ({ row }) => <BrandCell brand={row.original.brand} />,
      },
      {
        id: "cost_per_sms",
        header: "Cost / SMS",
        enableSorting: true,
        cell: ({ row }) => {
          const v = Number(row.original.cost_per_sms);
          return <span className="font-mono text-sm">${v.toFixed(4)}</span>;
        },
      },
      {
        id: "status",
        header: "Status",
        enableSorting: false,
        cell: ({ row }) => {
          const sc = row.original;
          if (sc.status === "archived") {
            return (
              <Badge className="border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                Archived
              </Badge>
            );
          }
          return (
            <StatusDropdown<"active" | "suspended" | "blocked">
              current={sc.status as "active" | "suspended" | "blocked"}
              options={STATUS_OPTIONS}
              onChange={(next) => handleStatusChange(sc, next)}
              isUpdating={statusApi.isLoading}
              isTerminal={!canUpdate}
            />
          );
        },
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const sc = row.original;
          const showEdit = canUpdate;
          const showArchive = sc.status !== "archived" && canArchive;
          const showRestore = sc.status === "archived" && canRestore;
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
                    <DropdownMenuItem onSelect={() => setEditing(sc)}>
                      <Pencil className="size-4" aria-hidden /> Edit
                    </DropdownMenuItem>
                  ) : null}
                  {showArchive ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirming({ kind: "archive", shortCode: sc })
                      }
                    >
                      <ArchiveIcon className="size-4" aria-hidden /> Archive
                    </DropdownMenuItem>
                  ) : null}
                  {showRestore ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirming({ kind: "restore", shortCode: sc })
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
    [canUpdate, canArchive, canRestore, statusApi.isLoading],
  );

  function toggleStatusFilter(s: ShortCodeStatus) {
    const set = new Set(filters.statuses);
    if (set.has(s)) set.delete(s);
    else set.add(s);
    const next = ALL_STATUSES.filter((x) => set.has(x));
    updateFilters({ statuses: next.length > 0 ? next : ["active"] });
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium">Short Codes</h2>
        {canCreate ? (
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="size-4" aria-hidden /> Add short code
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search short code…"
          className="h-9 w-full max-w-sm"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          {ALL_STATUSES.map((s) => {
            const active = filters.statuses.includes(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleStatusFilter(s)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs capitalize transition-colors",
                  active
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background text-muted-foreground hover:bg-muted",
                )}
              >
                {s}
              </button>
            );
          })}
        </div>
        {filters.search !== DEFAULT_FILTERS.search ||
        filters.statuses.join(",") !== DEFAULT_FILTERS.statuses.join(",") ? (
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

      {listError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">{listError}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={refetch}
          >
            Retry
          </Button>
        </div>
      ) : !listApi.isLoading && shortCodes.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed py-12 text-center">
          <p className="text-sm font-medium">No short codes yet</p>
          <p className="text-sm text-muted-foreground">
            Add the first short code for this provider.
          </p>
          {canCreate ? (
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="size-4" aria-hidden /> Add short code
            </Button>
          ) : null}
        </div>
      ) : (
        <DataTable<ShortCode>
          data={shortCodes}
          columns={columns}
          isLoading={listApi.isLoading}
          pageIndex={0}
          pageSize={shortCodes.length || 20}
          totalCount={shortCodes.length}
          onPageChange={() => {}}
          onPageSizeChange={() => {}}
          sortBy={filters.sortBy || null}
          sortDir={filters.sortDir}
          onSortChange={(by, dir) =>
            updateFilters({ sortBy: by ?? "created_at", sortDir: dir })
          }
        />
      )}

      {/* Add short code dialog */}
      <FormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Add short code</DialogTitle>
          <DialogDescription>For {providerName}</DialogDescription>
        </DialogHeader>
        <ShortCodeForm
          key="add"
          mode="create"
          onSubmit={handleAdd}
          onCancel={() => setAddOpen(false)}
          isSubmitting={createApi.isLoading}
        />
      </FormDialog>

      {/* Edit short code dialog */}
      <FormDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Edit short code</DialogTitle>
          <DialogDescription>{editing?.short_code ?? ""}</DialogDescription>
        </DialogHeader>
        {editing ? (
          <ShortCodeForm
            key={`edit-short-code-${editing.id}`}
            mode="edit"
            existingShortCode={editing.short_code}
            initialValues={{
              short_code: editing.short_code,
              cost_per_sms: Number(editing.cost_per_sms),
              brand_id: editing.brand_id,
            }}
            onSubmit={handleEdit}
            onCancel={() => setEditing(null)}
            isSubmitting={updateApi.isLoading}
          />
        ) : null}
      </FormDialog>

      {/* Archive/restore confirm */}
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
                ? "Archive this short code?"
                : "Restore this short code?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.kind === "archive"
                ? "Archived short codes can be restored later. Restored short codes come back as active."
                : "Restored short codes come back as active regardless of their pre-archive status."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={archiveApi.isLoading || restoreApi.isLoading}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleConfirm();
              }}
              disabled={archiveApi.isLoading || restoreApi.isLoading}
            >
              {confirming?.kind === "archive" ? "Archive" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
