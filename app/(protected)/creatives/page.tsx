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
  CreativeForm,
  type CreativeFormSubmit,
} from "@/components/creatives/creative-form";
import { DataTable } from "@/components/data-table";
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
import { calculateSmsSegments } from "@/lib/creative-helpers";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { cn } from "@/lib/utils";

type Info = { id: number; name: string; color: string | null };
type Status = "draft" | "pending" | "ready" | "paused" | "archived";
type ActiveStatus = Exclude<Status, "archived">;

type Creative = {
  id: number;
  creative_id: string | null;
  slug: string;
  org_id: string;
  offer_id: number;
  sms_provider_id: number | null;
  brand_id: number | null;
  text: string;
  status: Status;
  archived_at: string | null;
  created_at: string;
  offer: Info | null;
  provider: Info | null;
  brand: Info | null;
  campaign_count: number;
};

type ListResponse = { data: Creative[]; totalCount: number };
type InfoListResponse = { data: Info[] };

type Filters = {
  search: string;
  offer_id: number | null;
  sms_provider_id: number | null;
  brand_id: number | null;
  statuses: Status[];
  showArchived: boolean;
  page: number;
  pageSize: number;
  sortBy: string;
  sortDir: "asc" | "desc";
};

const ALL_ACTIVE_STATUSES: ActiveStatus[] = [
  "draft",
  "pending",
  "ready",
  "paused",
];

const DEFAULT_FILTERS: Filters = {
  search: "",
  offer_id: null,
  sms_provider_id: null,
  brand_id: null,
  statuses: [],
  showArchived: false,
  page: 0,
  pageSize: 20,
  sortBy: "created_at",
  sortDir: "desc",
};

const STATUS_OPTIONS: StatusOption<ActiveStatus>[] = [
  { value: "draft", label: "Draft", color: "gray" },
  { value: "pending", label: "Pending", color: "amber" },
  { value: "ready", label: "Ready", color: "green" },
  { value: "paused", label: "Paused", color: "orange" },
];

// Legal next-states per current state. Mirrors server-side state machine in
// /api/creatives/[id]/status/route.ts. The dropdown disables disallowed
// options so the UX surfaces the invariant without round-tripping a 409.
const TRANSITIONS: Record<ActiveStatus, ReadonlySet<ActiveStatus>> = {
  draft: new Set(["pending"]),
  pending: new Set(["draft", "ready"]),
  ready: new Set(["paused"]),
  paused: new Set(["ready"]),
};

const SEARCH_DEBOUNCE_MS = 300;
const FILTER_ALL = "__all__";

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

function Chip({ item }: { item: Info | null }) {
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

function ArchivedBadge() {
  return (
    <Badge className="border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      Archived
    </Badge>
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
    filters.sms_provider_id === DEFAULT_FILTERS.sms_provider_id &&
    filters.brand_id === DEFAULT_FILTERS.brand_id &&
    filters.statuses.length === 0 &&
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
  const createApi = useApiCall<Creative>();
  const updateApi = useApiCall<Creative>();
  const statusApi = useApiCall<Creative>();
  const archiveApi = useApiCall<Creative>();
  const restoreApi = useApiCall<Creative>();
  const duplicateApi = useApiCall<Creative>();
  const offersApi = useApiCall<InfoListResponse>();
  const providersApi = useApiCall<InfoListResponse>();
  const brandsApi = useApiCall<InfoListResponse>();

  const [data, setData] = useState<Creative[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refetch = useCallback(() => setRefreshTick((n) => n + 1), []);

  const [offers, setOffers] = useState<Info[]>([]);
  const [providers, setProviders] = useState<Info[]>([]);
  const [brands, setBrands] = useState<Info[]>([]);
  useEffect(() => {
    (async () => {
      const r = await offersApi.execute("/api/offers/list?pageSize=200");
      if (r.ok) setOffers(r.data.data);
    })();
  }, [offersApi.execute]);
  useEffect(() => {
    (async () => {
      const r = await providersApi.execute("/api/providers/list?pageSize=200");
      if (r.ok) setProviders(r.data.data);
    })();
  }, [providersApi.execute]);
  useEffect(() => {
    (async () => {
      const r = await brandsApi.execute("/api/brands/list?pageSize=200");
      if (r.ok) setBrands(r.data.data);
    })();
  }, [brandsApi.execute]);

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
    if (filters.sms_provider_id !== null)
      sp.set("sms_provider_id", String(filters.sms_provider_id));
    if (filters.brand_id !== null) sp.set("brand_id", String(filters.brand_id));
    if (filters.statuses.length > 0)
      sp.set("status", filters.statuses.join(","));
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
    filters.sms_provider_id,
    filters.brand_id,
    filters.statuses,
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
  const canApprove = can("creatives.approve");

  async function handleCreate(values: CreativeFormSubmit) {
    const result = await createApi.execute("/api/creatives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't create creative");
      return;
    }
    toast.success("Creative draft created");
    setCreateOpen(false);
    refetch();
  }

  async function handleEdit(values: CreativeFormSubmit) {
    if (!editing) return;
    const result = await updateApi.execute(`/api/creatives/${editing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't save creative");
      return;
    }
    toast.success("Creative saved");
    setEditing(null);
    refetch();
  }

  async function handleStatusChange(creative: Creative, next: ActiveStatus) {
    const result = await statusApi.execute(
      `/api/creatives/${creative.id}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't change status");
      return;
    }
    toast.success(`Status updated to ${next}`);
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
    // Open the new draft in the edit dialog so the user can iterate.
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
        id: "offer",
        header: "Offer",
        enableSorting: false,
        cell: ({ row }) => <Chip item={row.original.offer} />,
      },
      {
        id: "provider",
        header: "Provider",
        enableSorting: false,
        cell: ({ row }) => <Chip item={row.original.provider} />,
      },
      {
        id: "brand",
        header: "Brand",
        enableSorting: false,
        cell: ({ row }) => <Chip item={row.original.brand} />,
      },
      {
        id: "text",
        header: "Text",
        enableSorting: false,
        cell: ({ row }) => {
          const segs = calculateSmsSegments(row.original.text);
          return (
            <div className="min-w-0">
              <div className="truncate text-sm">
                {truncate(row.original.text, 60)}
              </div>
              <div className="text-xs text-muted-foreground">
                {segs.segments} seg · {segs.charset}
              </div>
            </div>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        enableSorting: true,
        cell: ({ row }) => {
          const c = row.original;
          if (c.status === "archived") return <ArchivedBadge />;
          // Build options where transitions disallowed from the current state
          // are disabled. The pending→ready option also disables if the user
          // lacks the approve permission.
          const allowed = TRANSITIONS[c.status as ActiveStatus];
          const opts: StatusOption<ActiveStatus>[] = STATUS_OPTIONS.map((o) => {
            const isCurrent = o.value === c.status;
            const isAllowed = isCurrent || allowed.has(o.value);
            const needsApprove =
              c.status === "pending" && o.value === "ready";
            return {
              ...o,
              disabled: !isAllowed || (needsApprove && !canApprove),
            };
          });
          return (
            <StatusDropdown<ActiveStatus>
              current={c.status as ActiveStatus}
              options={opts}
              onChange={(next) => handleStatusChange(c, next)}
              isUpdating={statusApi.isLoading}
              isTerminal={!canUpdate}
            />
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
    [
      canUpdate,
      canArchive,
      canRestore,
      canCreate,
      canApprove,
      statusApi.isLoading,
      handleStatusChange,
      handleDuplicate,
    ],
  );

  const isAuthLoading = !auth;
  const confirmBusy = archiveApi.isLoading || restoreApi.isLoading;
  const offerFilterValue =
    filters.offer_id === null ? FILTER_ALL : String(filters.offer_id);
  const providerFilterValue =
    filters.sms_provider_id === null
      ? FILTER_ALL
      : String(filters.sms_provider_id);
  const brandFilterValue =
    filters.brand_id === null ? FILTER_ALL : String(filters.brand_id);

  function toggleStatusFilter(s: Status) {
    const set = new Set(filters.statuses);
    if (set.has(s)) set.delete(s);
    else set.add(s);
    updateFilters({
      statuses: Array.from(set) as Status[],
      page: 0,
    });
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Creatives</h1>
          <p className="text-sm text-muted-foreground">
            SMS copy linked to offers. Drafts walk through approval before
            campaigns can use them.
          </p>
        </div>
        {canCreate ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden /> New Creative
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
          <SelectTrigger className="h-9 w-[180px]">
            <SelectValue placeholder="All offers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FILTER_ALL}>All offers</SelectItem>
            {offers.map((o) => (
              <SelectItem key={o.id} value={String(o.id)}>
                {o.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={providerFilterValue}
          onValueChange={(v) =>
            updateFilters({
              sms_provider_id: v === FILTER_ALL ? null : Number(v),
              page: 0,
            })
          }
        >
          <SelectTrigger className="h-9 w-[160px]">
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
        <Select
          value={brandFilterValue}
          onValueChange={(v) =>
            updateFilters({
              brand_id: v === FILTER_ALL ? null : Number(v),
              page: 0,
            })
          }
        >
          <SelectTrigger className="h-9 w-[160px]">
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
        <div className="flex flex-wrap items-center gap-1.5">
          {ALL_ACTIVE_STATUSES.map((s) => {
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
              Draft your first SMS message tied to an offer.
            </p>
          </div>
          {canCreate ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden /> New Creative
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

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New creative</DialogTitle>
            <DialogDescription>
              SMS copy linked to an offer, optionally scoped to a provider and
              brand.
            </DialogDescription>
          </DialogHeader>
          <CreativeForm
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
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
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
              currentStatus={editing.status}
              initialValues={{
                offer_id: editing.offer_id,
                sms_provider_id: editing.sms_provider_id,
                brand_id: editing.brand_id,
                text: editing.text,
                creative_id: editing.creative_id ?? "",
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
                ? "Archive this creative?"
                : "Restore this creative?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.kind === "archive"
                ? "Archived creatives are hidden from the active list and can't be used in new campaigns."
                : "Restoring brings the creative back as a draft so it goes through approval again."}
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
