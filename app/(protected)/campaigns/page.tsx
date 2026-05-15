"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  ArchiveRestore,
  Archive as ArchiveIcon,
  CheckCircle2,
  Copy,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Send,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import { type AudienceFilters } from "@/components/campaigns/campaign-form";
import {
  StatusChangeDialog,
  type CampaignTransition,
  transitionToStatus,
} from "@/components/campaigns/status-change-dialog";
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

type Info = { id: number; name: string; color: string | null };
type Status = "draft" | "active" | "paused" | "completed" | "archived";

type Campaign = {
  id: number;
  slug: string;
  human_id: string | null;
  name: string;
  notes: string | null;
  brand_id: number;
  offer_id: number;
  routing_type_id: number | null;
  traffic_type_id: number | null;
  assigned_to_user_id: string | null;
  created_by_user_id: string | null;
  audience_segment_ids: number[];
  audience_contact_group_ids: number[];
  audience_filters: AudienceFilters;
  audience_snapshot_count: number;
  audience_cap: number | null;
  start_date: string | null;
  end_date: string | null;
  status: Status;
  status_changed_at: string;
  archived_at: string | null;
  created_at: string;
  brand: Info | null;
  offer: Info | null;
  stage_count_total: number;
};

type Member = {
  id: string;
  email: string | null;
  display_name: string | null;
};

type ListResponse = { data: Campaign[]; totalCount: number };
type InfoListResponse = { data: Info[] };

const ALL_STATUSES: Status[] = [
  "draft",
  "active",
  "paused",
  "completed",
  "archived",
];

const STATUS_COLOR: Record<Status, string> = {
  draft:
    "border-slate-200 bg-slate-100 text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200",
  active:
    "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  paused:
    "border-orange-200 bg-orange-100 text-orange-800 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-200",
  completed:
    "border-sky-200 bg-sky-100 text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200",
  archived:
    "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
};

type Filters = {
  search: string;
  statuses: Status[];
  brand_id: number | null;
  offer_id: number | null;
  // "__me__" | "__unassigned__" | <uuid> | null
  assigned_to_user_id: string | null;
  showArchived: boolean;
  page: number;
  pageSize: number;
  sortBy: string;
  sortDir: "asc" | "desc";
};

const DEFAULT_FILTERS: Filters = {
  search: "",
  statuses: [],
  brand_id: null,
  offer_id: null,
  assigned_to_user_id: null,
  showArchived: false,
  page: 0,
  pageSize: 20,
  sortBy: "created_at",
  sortDir: "desc",
};

const SEARCH_DEBOUNCE_MS = 300;
const FILTER_ALL = "__all__";
const FILTER_ME = "__me__";
const FILTER_UNASSIGNED = "__unassigned__";

export default function CampaignsPage() {
  const router = useRouter();
  const { auth, can } = useAuth();

  const [filters, updateFilters, resetFilters] = usePersistedFilters<Filters>(
    "campaigns.filters",
    DEFAULT_FILTERS,
  );
  const filtersAreDefault =
    filters.search === DEFAULT_FILTERS.search &&
    filters.statuses.length === 0 &&
    filters.brand_id === DEFAULT_FILTERS.brand_id &&
    filters.offer_id === DEFAULT_FILTERS.offer_id &&
    filters.assigned_to_user_id === DEFAULT_FILTERS.assigned_to_user_id &&
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
  const brandsApi = useApiCall<InfoListResponse>();
  const offersApi = useApiCall<InfoListResponse>();
  const membersApi = useApiCall<{ data: Member[] }>();
  const statusApi = useApiCall<Campaign>();
  const archiveApi = useApiCall<Campaign>();
  const restoreApi = useApiCall<Campaign>();
  const duplicateApi = useApiCall<Campaign>();

  const [data, setData] = useState<Campaign[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refetch = useCallback(() => setRefreshTick((n) => n + 1), []);

  const [brands, setBrands] = useState<Info[]>([]);
  const [offers, setOffers] = useState<Info[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    (async () => {
      const r = await brandsApi.execute("/api/brands/list?pageSize=200");
      if (r.ok) setBrands(r.data.data);
    })();
  }, [brandsApi.execute]);
  useEffect(() => {
    (async () => {
      const r = await offersApi.execute("/api/offers/list?pageSize=200");
      if (r.ok) setOffers(r.data.data);
    })();
  }, [offersApi.execute]);
  useEffect(() => {
    (async () => {
      const r = await membersApi.execute("/api/members");
      if (r.ok) setMembers(r.data.data);
    })();
  }, [membersApi.execute]);

  // Resolve the assigned-to filter into the API's expected query value.
  const assignedQueryParam = useMemo(() => {
    if (filters.assigned_to_user_id === null) return null;
    if (filters.assigned_to_user_id === FILTER_ME)
      return auth?.user.id ?? null;
    if (filters.assigned_to_user_id === FILTER_UNASSIGNED) return "unassigned";
    return filters.assigned_to_user_id;
  }, [filters.assigned_to_user_id, auth?.user.id]);

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
    if (filters.statuses.length > 0)
      sp.set("status", filters.statuses.join(","));
    if (filters.brand_id !== null)
      sp.set("brand_id", String(filters.brand_id));
    if (filters.offer_id !== null)
      sp.set("offer_id", String(filters.offer_id));
    if (assignedQueryParam !== null)
      sp.set("assigned_to_user_id", assignedQueryParam);
    if (filters.showArchived) sp.set("showArchived", "true");

    (async () => {
      const result = await listApi.execute(
        `/api/campaigns/list?${sp.toString()}`,
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
    filters.statuses,
    filters.brand_id,
    filters.offer_id,
    assignedQueryParam,
    filters.showArchived,
    refreshTick,
    listApi.execute,
  ]);

  // Dialog state
  const [transitionTarget, setTransitionTarget] = useState<{
    campaign: Campaign;
    transition: CampaignTransition;
  } | null>(null);
  const [archiveConfirm, setArchiveConfirm] = useState<{
    kind: "archive" | "restore";
    campaign: Campaign;
  } | null>(null);

  // Bulk-selection state. Set of campaign IDs currently checked.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Drop selection whenever the underlying data changes (filters,
  // refetch, page change) so stale ids don't carry over.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [data]);
  const bulkApi = useApiCall<{
    succeeded: number[];
    failed: { id: number; reason: string }[];
  }>();
  async function runBulk(target: "paused" | "active" | "completed" | "archived" | "draft") {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    const result = await bulkApi.execute("/api/campaigns/bulk-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        campaign_ids: Array.from(selectedIds),
        target_status: target,
        confirm: true,
      }),
    });
    setBulkBusy(false);
    if (!result.ok) {
      toastApiError(result, "Couldn't apply bulk action");
      return;
    }
    const { succeeded, failed } = result.data;
    if (succeeded.length > 0 && failed.length === 0) {
      toast.success(`${succeeded.length} campaigns updated`);
    } else if (succeeded.length > 0) {
      toast.warning(
        `${succeeded.length} updated, ${failed.length} skipped: ${failed.map((f) => f.reason).slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}`,
      );
    } else {
      toast.error(
        `0 updated, ${failed.length} skipped: ${failed.map((f) => f.reason).slice(0, 3).join(", ")}`,
      );
    }
    setSelectedIds(new Set());
    refetch();
  }

  const canCreate = can("campaigns.create");
  const canUpdate = can("campaigns.update");
  const canActivate = can("campaigns.activate");
  const canPause = can("campaigns.pause");
  const canComplete = can("campaigns.complete");
  const canArchive = can("campaigns.archive");
  const canRestore = can("campaigns.restore");

  // ============ Status transitions ============

  async function handleTransitionConfirm() {
    if (!transitionTarget) return;
    const next = transitionToStatus(transitionTarget.transition);
    const result = await statusApi.execute(
      `/api/campaigns/${transitionTarget.campaign.id}/status`,
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
    toast.success(`Campaign ${next}`);
    setTransitionTarget(null);
    refetch();
  }

  async function handleDuplicate(c: Campaign) {
    const result = await duplicateApi.execute(
      `/api/campaigns/${c.id}/duplicate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ include_stages: true }),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't duplicate campaign");
      return;
    }
    toast.success(`Duplicated as "${result.data.name}"`);
    router.push(`/campaigns/${result.data.id}`);
  }

  async function handleArchiveRestoreConfirm() {
    if (!archiveConfirm) return;
    const isArchive = archiveConfirm.kind === "archive";
    const api = isArchive ? archiveApi : restoreApi;
    const result = await api.execute(
      `/api/campaigns/${archiveConfirm.campaign.id}/${isArchive ? "archive" : "restore"}`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    toast.success(isArchive ? "Campaign archived" : "Campaign restored");
    setArchiveConfirm(null);
    refetch();
  }

  // ============ Columns ============

  function memberLabel(userId: string | null) {
    if (!userId) return null;
    const m = members.find((mm) => mm.id === userId);
    return m?.display_name ?? m?.email ?? "Member";
  }

  const columns = useMemo<ColumnDef<Campaign>[]>(
    () => [
      {
        id: "select",
        header: () => null,
        enableSorting: false,
        cell: ({ row }) => (
          <input
            type="checkbox"
            checked={selectedIds.has(row.original.id)}
            onClick={(e) => e.stopPropagation()}
            onChange={() =>
              setSelectedIds((prev) => {
                const next = new Set(prev);
                if (next.has(row.original.id)) next.delete(row.original.id);
                else next.add(row.original.id);
                return next;
              })
            }
            aria-label="Select campaign"
            className="size-4 cursor-pointer"
          />
        ),
      },
      {
        id: "name",
        header: "Name",
        enableSorting: true,
        cell: ({ row }) => {
          const c = row.original;
          return (
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{c.name}</span>
                {c.human_id ? (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {c.human_id}
                  </Badge>
                ) : null}
              </div>
              <div className="font-mono text-xs text-muted-foreground">
                {c.slug}
              </div>
            </div>
          );
        },
      },
      {
        id: "brand",
        header: "Brand",
        enableSorting: false,
        cell: ({ row }) => {
          const b = row.original.brand;
          if (!b) return <span className="text-muted-foreground">—</span>;
          return (
            <span className="inline-flex items-center gap-1.5">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: b.color ?? "#64748B" }}
              />
              <span className="text-sm">{b.name}</span>
            </span>
          );
        },
      },
      {
        id: "offer",
        header: "Offer",
        enableSorting: false,
        cell: ({ row }) => {
          const o = row.original.offer;
          if (!o) return <span className="text-muted-foreground">—</span>;
          return (
            <span className="inline-flex items-center gap-1.5">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: o.color ?? "#64748B" }}
              />
              <span className="text-sm">{o.name}</span>
            </span>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        enableSorting: true,
        cell: ({ row }) => {
          const s = row.original.status;
          return (
            <Badge className={cn("capitalize", STATUS_COLOR[s])}>{s}</Badge>
          );
        },
      },
      {
        id: "audience",
        header: "Audience",
        enableSorting: false,
        cell: ({ row }) => {
          const n = row.original.audience_snapshot_count;
          if (n === 0) return <span className="text-muted-foreground">—</span>;
          return (
            <span className="font-mono tabular-nums">
              {n.toLocaleString()}
            </span>
          );
        },
      },
      {
        id: "stages",
        header: "Stages",
        enableSorting: false,
        cell: ({ row }) => {
          const n = row.original.stage_count_total;
          if (n === 0) return <span className="text-muted-foreground">—</span>;
          return (
            <Badge variant="secondary">
              {n} stage{n === 1 ? "" : "s"}
            </Badge>
          );
        },
      },
      {
        id: "assigned",
        header: "Assigned",
        enableSorting: false,
        cell: ({ row }) => {
          const label = memberLabel(row.original.assigned_to_user_id);
          if (!label)
            return <span className="text-muted-foreground">Unassigned</span>;
          const initial = label.charAt(0).toUpperCase();
          return (
            <span className="inline-flex items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium">
                {initial}
              </span>
              <span className="truncate text-sm">{label}</span>
            </span>
          );
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
          const transitions: {
            label: string;
            t: CampaignTransition;
            icon: React.ReactNode;
          }[] = [];
          if (c.status === "draft" && canActivate)
            transitions.push({
              label: "Activate",
              t: "activate",
              icon: <Send className="size-4" aria-hidden />,
            });
          if (c.status === "active" && canPause)
            transitions.push({
              label: "Pause",
              t: "pause",
              icon: <Pause className="size-4" aria-hidden />,
            });
          if (c.status === "active" && canComplete)
            transitions.push({
              label: "Mark complete",
              t: "complete",
              icon: <CheckCircle2 className="size-4" aria-hidden />,
            });
          if (c.status === "paused" && canPause)
            transitions.push({
              label: "Resume",
              t: "resume",
              icon: <Play className="size-4" aria-hidden />,
            });
          if (c.status === "paused" && canComplete)
            transitions.push({
              label: "Mark complete",
              t: "complete",
              icon: <CheckCircle2 className="size-4" aria-hidden />,
            });

          if (
            !showEdit &&
            !showArchive &&
            !showRestore &&
            !canCreate &&
            transitions.length === 0
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
                    <DropdownMenuItem
                      onSelect={() => router.push(`/campaigns/${c.id}/edit`)}
                    >
                      <Pencil className="size-4" aria-hidden /> Edit
                    </DropdownMenuItem>
                  ) : null}
                  {canCreate ? (
                    <DropdownMenuItem
                      onSelect={() => void handleDuplicate(c)}
                    >
                      <Copy className="size-4" aria-hidden /> Duplicate
                    </DropdownMenuItem>
                  ) : null}
                  {transitions.length > 0 ? (
                    <>
                      {showEdit ? <DropdownMenuSeparator /> : null}
                      {transitions.map((tr) => (
                        <DropdownMenuItem
                          key={tr.t}
                          onSelect={() =>
                            setTransitionTarget({
                              campaign: c,
                              transition: tr.t,
                            })
                          }
                        >
                          {tr.icon} {tr.label}
                        </DropdownMenuItem>
                      ))}
                    </>
                  ) : null}
                  {showArchive || showRestore ? (
                    <DropdownMenuSeparator />
                  ) : null}
                  {showArchive ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setArchiveConfirm({ kind: "archive", campaign: c })
                      }
                    >
                      <ArchiveIcon className="size-4" aria-hidden /> Archive
                    </DropdownMenuItem>
                  ) : null}
                  {showRestore ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setArchiveConfirm({ kind: "restore", campaign: c })
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
      canActivate,
      canPause,
      canComplete,
      canArchive,
      canRestore,
      members,
      selectedIds,
    ],
  );

  // ============ Filter helpers ============

  function toggleStatus(s: Status) {
    const set = new Set(filters.statuses);
    if (set.has(s)) set.delete(s);
    else set.add(s);
    updateFilters({ statuses: Array.from(set) as Status[], page: 0 });
  }

  const brandFilterValue =
    filters.brand_id === null ? FILTER_ALL : String(filters.brand_id);
  const offerFilterValue =
    filters.offer_id === null ? FILTER_ALL : String(filters.offer_id);
  const assignedFilterValue = filters.assigned_to_user_id ?? FILTER_ALL;

  const confirmBusy = archiveApi.isLoading || restoreApi.isLoading;
  const isAuthLoading = !auth;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
          <p className="text-sm text-muted-foreground">
            Long-running outreach efforts. Each campaign contains one or more
            send stages.
          </p>
        </div>
        {canCreate ? (
          <Button asChild>
            <Link href="/campaigns/new">
              <Plus className="size-4" aria-hidden /> New Campaign
            </Link>
          </Button>
        ) : null}
      </header>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by name, human ID, or slug…"
          className="h-9 w-full max-w-sm"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          {ALL_STATUSES.filter((s) => s !== "archived").map((s) => {
            const active = filters.statuses.includes(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleStatus(s)}
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
        <Select
          value={offerFilterValue}
          onValueChange={(v) =>
            updateFilters({
              offer_id: v === FILTER_ALL ? null : Number(v),
              page: 0,
            })
          }
        >
          <SelectTrigger className="h-9 w-[160px]">
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
          value={assignedFilterValue}
          onValueChange={(v) =>
            updateFilters({
              assigned_to_user_id: v === FILTER_ALL ? null : v,
              page: 0,
            })
          }
        >
          <SelectTrigger className="h-9 w-[160px]">
            <SelectValue placeholder="Anyone" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FILTER_ALL}>Anyone</SelectItem>
            <SelectItem value={FILTER_ME}>Me</SelectItem>
            <SelectItem value={FILTER_UNASSIGNED}>Unassigned</SelectItem>
            {members.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.display_name ?? m.email ?? m.id}
              </SelectItem>
            ))}
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
      </div>

      {fetchError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">
            Couldn&apos;t load campaigns: {fetchError}
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
          <Send className="size-12 text-muted-foreground/40" aria-hidden />
          <div className="space-y-1">
            <p className="text-sm font-medium">No campaigns yet</p>
            <p className="text-sm text-muted-foreground">
              Create your first campaign to start drafting stages.
            </p>
          </div>
          {canCreate ? (
            <Button asChild>
              <Link href="/campaigns/new">
                <Plus className="size-4" aria-hidden /> New Campaign
              </Link>
            </Button>
          ) : null}
        </div>
      ) : !listApi.isLoading && data.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">
            No campaigns match your filters.
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
        <>
          {selectedIds.size > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <div>
                <span className="font-medium">{selectedIds.size}</span>{" "}
                campaign{selectedIds.size === 1 ? "" : "s"} selected
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedIds(new Set())}
                  disabled={bulkBusy}
                >
                  Clear
                </Button>
                {canPause ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runBulk("paused")}
                    disabled={bulkBusy}
                  >
                    Pause
                  </Button>
                ) : null}
                {canPause ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runBulk("active")}
                    disabled={bulkBusy}
                  >
                    Resume
                  </Button>
                ) : null}
                {canComplete ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runBulk("completed")}
                    disabled={bulkBusy}
                  >
                    Mark complete
                  </Button>
                ) : null}
                {canArchive ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runBulk("archived")}
                    disabled={bulkBusy}
                  >
                    Archive
                  </Button>
                ) : null}
                {canRestore ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runBulk("draft")}
                    disabled={bulkBusy}
                  >
                    Restore
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          <DataTable<Campaign>
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
            onRowClick={(c) => router.push(`/campaigns/${c.id}`)}
          />
        </>
      )}

      {/* Status transition dialog */}
      <StatusChangeDialog
        transition={transitionTarget?.transition ?? null}
        campaignName={transitionTarget?.campaign.name ?? null}
        isPending={statusApi.isLoading}
        onCancel={() => setTransitionTarget(null)}
        onConfirm={handleTransitionConfirm}
      />

      {/* Archive / restore confirm */}
      <AlertDialog
        open={archiveConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setArchiveConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {archiveConfirm?.kind === "archive"
                ? "Archive this campaign?"
                : "Restore this campaign?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {archiveConfirm?.kind === "archive"
                ? "Archived campaigns are hidden from the active list. Data is preserved."
                : "Restoring brings the campaign back as a draft so any subsequent activation is an explicit action."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirmBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleArchiveRestoreConfirm();
              }}
              disabled={confirmBusy}
            >
              {archiveConfirm?.kind === "archive" ? "Archive" : "Restore"}
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
