"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  ArchiveRestore,
  Archive as ArchiveIcon,
  Check,
  Copy,
  MoreHorizontal,
  Phone,
  Plus,
  ShieldX,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import { ContactStatusImportForm } from "@/components/contacts/contact-status-import-form";
import { DataTable } from "@/components/data-table";
import { ExportButton } from "@/components/export-button";
import { MultiSelectPicker } from "@/components/multi-select-picker";
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
import { CONTACT_STATUS_LABELS } from "@/lib/imports/contact-status";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { formatPhoneInternational } from "@/lib/phone-validation";
import { cn } from "@/lib/utils";

type ContactGroupBadge = {
  id: number;
  name: string;
  color: string | null;
};

type Contact = {
  id: string;
  org_id: string;
  phone_number: string;
  is_archived: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  line_type: string;
  carrier_norm: string;
  messaging_status: string;
  groups: ContactGroupBadge[];
  // Distinct opt_outs reasons present for this contact. Drives the
  // "Status indicators" column. Empty when the contact has no suppressions.
  statuses: string[];
};

// Contacts is the ONE screen where landlines remain visible, so the Type
// column labels landline as "Landline / Not applicable".
const LINE_TYPE_LABELS: Record<string, string> = {
  mobile: "Mobile",
  landline: "Landline / Not applicable",
  voip: "VoIP",
  toll_free: "Toll-free",
  unknown: "Unknown",
};

// Reason → badge label + classes. Covers the three import statuses plus
// 'bounced' (set by campaign-result imports) so every opt_outs reason renders.
const STATUS_DISPLAY: Record<string, { label: string; className: string }> = {
  opt_out: {
    label: CONTACT_STATUS_LABELS.opt_out,
    className:
      "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  },
  suppressed: {
    label: CONTACT_STATUS_LABELS.suppressed,
    className:
      "border-rose-200 bg-rose-100 text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200",
  },
  scrubbed: {
    label: CONTACT_STATUS_LABELS.scrubbed,
    className:
      "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300",
  },
  bounced: {
    label: "Bounced",
    className:
      "border-orange-200 bg-orange-100 text-orange-800 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-200",
  },
};

// Stable display order so the badges don't reshuffle per row.
const STATUS_ORDER: string[] = ["opt_out", "suppressed", "scrubbed", "bounced"];

type ContactView = "active" | "archived" | "opt_outs" | "opt_ins" | "clickers";

type ListResponse = {
  data: Contact[];
  totalCount: number;
  countApprox?: boolean;
  hasMore?: boolean;
  page: number;
  pageSize: number;
  view: ContactView;
  placeholder?: boolean;
};

type BaseStats = {
  total: number;
  archived: number;
  opt_out_count: number;
  opt_in_count: number;
  clicker_count: number;
};

type CarrierStats = {
  total: number;
  by_line_type: Record<string, number>;
  by_carrier_norm: Record<string, number>;
  by_messaging_status: { eligible: number; not_applicable: number };
};

type Filters = {
  search: string;
  view: ContactView;
  page: number;
  pageSize: number;
  sortBy: string;
  sortDir: "asc" | "desc";
  group_ids: number[];
};

const DEFAULT_FILTERS: Filters = {
  search: "",
  view: "active",
  page: 0,
  pageSize: 20,
  sortBy: "created_at",
  sortDir: "desc",
  group_ids: [],
};

const VIEW_LABELS: Record<ContactView, string> = {
  active: "active contacts",
  archived: "archived contacts",
  opt_outs: "opt-outs",
  opt_ins: "opt-ins",
  clickers: "clickers",
};

const SEARCH_DEBOUNCE_MS = 300;

function PhoneCell({ contact }: { contact: Contact }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(contact.phone_number);
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
      <span>{formatPhoneInternational(contact.phone_number)}</span>
      {copied ? (
        <Check className="size-3 text-emerald-600" aria-hidden />
      ) : (
        <Copy className="size-3 opacity-40" aria-hidden />
      )}
    </button>
  );
}

function StatusBadge({ archived }: { archived: boolean }) {
  if (!archived) {
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

function StatTile({
  label,
  value,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  value: number | null;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-3 rounded-md border bg-background p-3 text-left transition-colors",
        "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && "border-foreground ring-2 ring-foreground/10",
      )}
    >
      <div
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-md",
          active ? "bg-foreground text-background" : "bg-muted",
        )}
      >
        <Icon
          className={cn(
            "size-4",
            active ? "text-background" : "text-muted-foreground",
          )}
          aria-hidden
        />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-lg font-semibold tabular-nums">
          {value === null ? "—" : value.toLocaleString()}
        </div>
      </div>
    </button>
  );
}

// Short line-type labels for the compact base-mix widget (the table column
// uses the longer LINE_TYPE_LABELS with the landline caveat).
const LINE_TYPE_SHORT: Record<string, string> = {
  mobile: "Mobile",
  landline: "Landline",
  voip: "VoIP",
  toll_free: "Toll-free",
  unknown: "Unknown",
};

const LINE_TYPE_ORDER = ["mobile", "voip", "toll_free", "landline", "unknown"];
const CARRIER_ORDER = [
  "AT&T",
  "T-Mobile",
  "Verizon",
  "Other Mobile",
  "VoIP",
  "Unknown",
  "Unmapped",
  "Unidentified",
];

function MixRow({
  label,
  value,
  total,
  muted,
}: {
  label: string;
  value: number;
  total: number;
  muted?: boolean;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className={muted ? "text-muted-foreground" : undefined}>
        {label}
      </span>
      <span className="font-mono tabular-nums text-muted-foreground">
        {value.toLocaleString()}{" "}
        <span className="opacity-60">({pct}%)</span>
      </span>
    </div>
  );
}

// Base-mix breakdown by messaging status, line type, and carrier. This is
// the one screen where landlines / not-applicable numbers stay visible.
function BaseMixWidget({ stats }: { stats: CarrierStats | null }) {
  if (!stats || stats.total === 0) return null;
  const total = stats.total;
  const lineTypes = LINE_TYPE_ORDER.filter((k) => (stats.by_line_type[k] ?? 0) > 0);
  const carriers = CARRIER_ORDER.filter(
    (k) => (stats.by_carrier_norm[k] ?? 0) > 0,
  );
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Base mix · {total.toLocaleString()} contacts
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-1">
          <div className="text-[11px] font-medium text-muted-foreground">
            Messaging
          </div>
          <MixRow
            label="Eligible"
            value={stats.by_messaging_status.eligible}
            total={total}
          />
          <MixRow
            label="Not applicable"
            value={stats.by_messaging_status.not_applicable}
            total={total}
            muted
          />
        </div>
        <div className="grid gap-1">
          <div className="text-[11px] font-medium text-muted-foreground">
            Line type
          </div>
          {lineTypes.map((k) => (
            <MixRow
              key={k}
              label={LINE_TYPE_SHORT[k] ?? k}
              value={stats.by_line_type[k] ?? 0}
              total={total}
              muted={k === "landline" || k === "unknown"}
            />
          ))}
        </div>
        <div className="grid gap-1">
          <div className="text-[11px] font-medium text-muted-foreground">
            Carrier
          </div>
          {carriers.map((k) => (
            <MixRow
              key={k}
              label={k}
              value={stats.by_carrier_norm[k] ?? 0}
              total={total}
              muted={k === "Unidentified" || k === "Unmapped" || k === "Unknown"}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function ContactsPage() {
  const { auth, can } = useAuth();

  const [filters, updateFilters, resetFilters] = usePersistedFilters<Filters>(
    "contacts.filters",
    DEFAULT_FILTERS,
  );
  const filtersAreDefault =
    filters.search === DEFAULT_FILTERS.search &&
    filters.view === DEFAULT_FILTERS.view &&
    filters.group_ids.length === 0;

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
  const statsApi = useApiCall<BaseStats>();
  const carrierStatsApi = useApiCall<CarrierStats>();
  const archiveApi = useApiCall<Contact>();
  const restoreApi = useApiCall<Contact>();
  const deleteApi = useApiCall<{ ok: true; id: string }>();
  const groupsApi = useApiCall<{ data: ContactGroupBadge[] }>();
  const bulkApplyApi = useApiCall<{ applied: number }>();

  const [data, setData] = useState<Contact[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [countApprox, setCountApprox] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [stats, setStats] = useState<BaseStats | null>(null);
  const [carrierStats, setCarrierStats] = useState<CarrierStats | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refetch = useCallback(() => setRefreshTick((n) => n + 1), []);

  // Contact groups for the filter + bulk-apply dialog. Loaded once on mount.
  const [contactGroups, setContactGroups] = useState<ContactGroupBadge[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await groupsApi.execute(
        "/api/contact-groups/list?pageSize=200",
      );
      if (cancelled) return;
      if (r.ok) setContactGroups(r.data.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [groupsApi.execute]);

  // Bulk selection of contact rows.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  // Clear selection when the page or view changes — different rows now.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [filters.page, filters.view, filters.search, filters.group_ids.join(",")]);

  // Bulk-apply-groups dialog.
  const [applyOpen, setApplyOpen] = useState(false);
  const [applyGroupIds, setApplyGroupIds] = useState<number[]>([]);
  async function handleApplyGroups() {
    if (selectedIds.size === 0 || applyGroupIds.length === 0) return;
    const r = await bulkApplyApi.execute("/api/contacts/bulk-apply-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contact_ids: Array.from(selectedIds),
        group_ids: applyGroupIds,
      }),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't apply groups");
      return;
    }
    toast.success(
      `Applied ${r.data.applied.toLocaleString()} new group membership${r.data.applied === 1 ? "" : "s"}`,
    );
    setApplyOpen(false);
    setApplyGroupIds([]);
    setSelectedIds(new Set());
    refetch();
  }

  useEffect(() => {
    let cancelled = false;
    setFetchError(null);

    const params = new URLSearchParams({
      page: String(filters.page),
      pageSize: String(filters.pageSize),
      sortBy: filters.sortBy,
      sortDir: filters.sortDir,
      view: filters.view,
    });
    if (filters.search) params.set("search", filters.search);
    if (filters.group_ids.length > 0)
      params.set("group_ids", filters.group_ids.join(","));

    (async () => {
      const result = await listApi.execute(
        `/api/contacts/list?${params.toString()}`,
      );
      if (cancelled) return;
      if (result.ok) {
        setData(result.data.data);
        setTotalCount(result.data.totalCount);
        setCountApprox(result.data.countApprox ?? false);
        setHasMore(result.data.hasMore ?? false);
      } else {
        setFetchError(result.error);
      }
    })();
    return () => {
      cancelled = true;
    };
    // group_ids array identity changes per render; collapse to a stable
    // string key in the dep array so the effect only refires on actual change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filters.page,
    filters.pageSize,
    filters.sortBy,
    filters.sortDir,
    filters.search,
    filters.view,
    filters.group_ids.join(","),
    refreshTick,
    listApi.execute,
  ]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await statsApi.execute("/api/contacts/base-stats");
      if (cancelled) return;
      if (result.ok) setStats(result.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshTick, statsApi.execute]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await carrierStatsApi.execute(
        "/api/contacts/carrier-stats",
      );
      if (cancelled) return;
      if (result.ok) setCarrierStats(result.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshTick, carrierStatsApi.execute]);

  const [uploadOpen, setUploadOpen] = useState(false);
  // Optional segment assignment: contacts go into one segment if picked.
  // Contact-group *tagging* is handled separately by PhoneUploadForm's
  // own MultiSelectPicker (enableContactGroups). The old "assign to a
  // segment group" branch is gone — segment_groups were renamed to
  // contact_groups in migration 0031 and no longer function as a folder
  // of segments.
  type AssignMode = "none" | "segment";
  const [assignMode, setAssignMode] = useState<AssignMode>("none");
  const [assignSegmentId, setAssignSegmentId] = useState<number | null>(null);
  const [segmentsForAssign, setSegmentsForAssign] = useState<
    { id: number; name: string }[]
  >([]);
  const segmentsAssignApi = useApiCall<{
    data: { id: number; name: string }[];
  }>();

  // Lazy-load the segment picker when the user opens the upload dialog so
  // we don't fetch on every contacts page render.
  useEffect(() => {
    if (!uploadOpen) return;
    (async () => {
      const r = await segmentsAssignApi.execute(
        "/api/segments/list?pageSize=100&sortBy=name&sortDir=asc",
      );
      if (r.ok) setSegmentsForAssign(r.data.data);
    })();
  }, [uploadOpen, segmentsAssignApi.execute]);

  const [confirming, setConfirming] = useState<
    | { kind: "archive"; contact: Contact }
    | { kind: "restore"; contact: Contact }
    | { kind: "delete"; contact: Contact }
    | null
  >(null);

  const canUpload = can("contacts.upload");
  const canImportStatuses = can("opt_outs.upload");
  const canArchive = can("contacts.archive");
  const canDelete = can("contacts.delete");

  const [statusImportOpen, setStatusImportOpen] = useState(false);

  async function handleConfirm() {
    if (!confirming) return;
    if (confirming.kind === "delete") {
      const result = await deleteApi.execute(
        `/api/contacts/${confirming.contact.id}`,
        { method: "DELETE" },
      );
      if (!result.ok) {
        toastApiError(result, "Couldn't delete contact");
        return;
      }
      toast.success("Contact deleted");
      setConfirming(null);
      refetch();
      return;
    }
    const isArchive = confirming.kind === "archive";
    const api = isArchive ? archiveApi : restoreApi;
    const result = await api.execute(
      `/api/contacts/${confirming.contact.id}/${isArchive ? "archive" : "restore"}`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    toast.success(isArchive ? "Contact archived" : "Contact restored");
    setConfirming(null);
    refetch();
  }

  function handleUploadSuccess(
    summary: UploadResultSummary & { segments_assigned?: number },
  ) {
    const assignedSuffix =
      summary.segments_assigned && summary.segments_assigned > 0
        ? ` · assigned to ${summary.segments_assigned} segment${
            summary.segments_assigned === 1 ? "" : "s"
          }`
        : "";
    toast.success(
      `Uploaded ${summary.inserted.toLocaleString()} new contact${
        summary.inserted === 1 ? "" : "s"
      }${
        summary.duplicates_in_db > 0
          ? ` (${summary.duplicates_in_db.toLocaleString()} already in your list)`
          : ""
      }${assignedSuffix}`,
    );
    refetch();
    // Form stays open showing the result screen; user closes it via "Done".
  }

  // Snapshot the additional fields the upload form will POST. Currently
  // only the segment-assignment branch contributes — contact-group
  // tagging is handled inside PhoneUploadForm via assign_to_group_ids.
  function buildUploadFields(): Record<string, unknown> {
    if (assignMode === "segment" && assignSegmentId !== null) {
      return { assign_to_segment_id: assignSegmentId };
    }
    return {};
  }

  const uploadReady =
    assignMode === "none" ||
    (assignMode === "segment" && assignSegmentId !== null);

  const columns = useMemo<ColumnDef<Contact>[]>(
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
            onChange={() => toggleSelected(row.original.id)}
            aria-label="Select row"
            className="size-4 cursor-pointer"
          />
        ),
      },
      {
        id: "phone_number",
        header: "Phone Number",
        cell: ({ row }) => <PhoneCell contact={row.original} />,
        enableSorting: true,
      },
      {
        id: "line_type",
        header: "Type",
        enableSorting: false,
        cell: ({ row }) => {
          const lt = row.original.line_type;
          const label = LINE_TYPE_LABELS[lt] ?? lt;
          return (
            <span
              className={cn(
                "text-sm",
                lt === "landline" || lt === "unknown"
                  ? "text-muted-foreground"
                  : undefined,
              )}
            >
              {label}
            </span>
          );
        },
      },
      {
        id: "carrier_norm",
        header: "Carrier",
        enableSorting: false,
        cell: ({ row }) => {
          const c = row.original.carrier_norm;
          return (
            <span
              className={cn(
                "text-sm",
                c === "Unidentified" || c === "Unmapped" || c === "Unknown"
                  ? "text-muted-foreground"
                  : undefined,
              )}
            >
              {c}
            </span>
          );
        },
      },
      {
        id: "indicators",
        header: "Status indicators",
        enableSorting: false,
        cell: ({ row }) => {
          const statuses = row.original.statuses ?? [];
          if (statuses.length === 0)
            return <span className="text-muted-foreground">—</span>;
          const ordered = (STATUS_ORDER as string[]).filter((s) =>
            statuses.includes(s),
          );
          return (
            <div className="flex flex-wrap gap-1">
              {ordered.map((s) => {
                const d = STATUS_DISPLAY[s];
                return (
                  <span
                    key={s}
                    className={cn(
                      "inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs",
                      d?.className,
                    )}
                  >
                    {d?.label ?? s}
                  </span>
                );
              })}
            </div>
          );
        },
      },
      {
        id: "groups",
        header: "Groups",
        enableSorting: false,
        cell: ({ row }) => {
          const gs = row.original.groups;
          if (!gs || gs.length === 0)
            return <span className="text-muted-foreground">—</span>;
          const visible = gs.slice(0, 3);
          const overflow = gs.slice(3);
          return (
            <div className="flex flex-wrap gap-1">
              {visible.map((g) => (
                <span
                  key={g.id}
                  className="inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-xs"
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: g.color ?? "#64748B" }}
                  />
                  {g.name}
                </span>
              ))}
              {overflow.length > 0 ? (
                <span
                  className="inline-flex items-center rounded-md border bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground"
                  title={overflow.map((g) => g.name).join(", ")}
                >
                  +{overflow.length} more
                </span>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "is_archived",
        header: "Archived",
        enableSorting: false,
        cell: ({ row }) => (
          <StatusBadge archived={row.original.is_archived} />
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
          const c = row.original;
          if (!canArchive && !canDelete) return null;
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
                  {canArchive && !c.is_archived ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirming({ kind: "archive", contact: c })
                      }
                    >
                      <ArchiveIcon className="size-4" aria-hidden /> Archive
                    </DropdownMenuItem>
                  ) : null}
                  {canArchive && c.is_archived ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirming({ kind: "restore", contact: c })
                      }
                    >
                      <ArchiveRestore className="size-4" aria-hidden /> Restore
                    </DropdownMenuItem>
                  ) : null}
                  {canDelete ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirming({ kind: "delete", contact: c })
                      }
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="size-4" aria-hidden /> Delete
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      },
    ],
    [canArchive, canDelete, selectedIds],
  );

  const isAuthLoading = !auth;
  const confirmBusy =
    archiveApi.isLoading || restoreApi.isLoading || deleteApi.isLoading;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
          <p className="text-sm text-muted-foreground">
            All phone numbers in your audience. Bulk upload via paste or CSV.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canImportStatuses ? (
            <Button variant="outline" onClick={() => setStatusImportOpen(true)}>
              <ShieldX className="size-4" aria-hidden /> Import statuses
            </Button>
          ) : null}
          {canUpload ? (
            <Button onClick={() => setUploadOpen(true)}>
              <Plus className="size-4" aria-hidden /> Upload contacts
            </Button>
          ) : null}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatTile
          label="Total contacts"
          value={stats?.total ?? null}
          icon={Users}
          active={filters.view === "active"}
          onClick={() => updateFilters({ view: "active", page: 0 })}
        />
        <StatTile
          label="Archived"
          value={stats?.archived ?? null}
          icon={ArchiveIcon}
          active={filters.view === "archived"}
          onClick={() => updateFilters({ view: "archived", page: 0 })}
        />
        <StatTile
          label="Opt-outs"
          value={stats?.opt_out_count ?? null}
          icon={Phone}
          active={filters.view === "opt_outs"}
          onClick={() => updateFilters({ view: "opt_outs", page: 0 })}
        />
        <StatTile
          label="Opt-ins"
          value={stats?.opt_in_count ?? null}
          icon={Phone}
          active={filters.view === "opt_ins"}
          onClick={() => updateFilters({ view: "opt_ins", page: 0 })}
        />
        <StatTile
          label="Clickers"
          value={stats?.clicker_count ?? null}
          icon={Phone}
          active={filters.view === "clickers"}
          onClick={() => updateFilters({ view: "clickers", page: 0 })}
        />
      </div>

      <BaseMixWidget stats={carrierStats} />

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={`Search ${VIEW_LABELS[filters.view]} by phone…`}
          className="h-9 w-full max-w-sm"
        />
        <div className="w-[260px]">
          <MultiSelectPicker
            options={contactGroups.map((g) => ({
              id: g.id,
              label: g.name,
              color: g.color,
            }))}
            value={filters.group_ids}
            onChange={(next) =>
              updateFilters({ group_ids: next as number[], page: 0 })
            }
            placeholder="Filter by groups"
            selectedLabel={(n) =>
              `${n} group${n === 1 ? "" : "s"} filtered`
            }
            isLoading={groupsApi.isLoading && contactGroups.length === 0}
            emptyMessage="No contact groups available."
            searchPlaceholder="Search groups…"
          />
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
        <div className="ml-auto">
          <ExportButton
            endpoint="/api/contacts/export"
            permission="contacts.view"
            filenamePrefix="contacts"
            queryParams={{
              view: filters.view,
              search: filters.search || undefined,
              sortBy: filters.sortBy,
              sortDir: filters.sortDir,
            }}
            disabledIfEmpty={totalCount}
          />
        </div>
      </div>

      {selectedIds.size > 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <div>
            <span className="font-medium">{selectedIds.size}</span> selected
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedIds(new Set())}
            >
              Clear
            </Button>
            {can("contact_contact_groups.manage") ? (
              <Button
                size="sm"
                onClick={() => {
                  setApplyGroupIds([]);
                  setApplyOpen(true);
                }}
              >
                Apply to groups
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {fetchError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">
            Couldn&apos;t load contacts: {fetchError}
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
      ) : !listApi.isLoading &&
        data.length === 0 &&
        filtersAreDefault &&
        filters.view === "active" ? (
        <div
          className={cn(
            "flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-16 text-center",
          )}
        >
          <Users className="size-12 text-muted-foreground/40" aria-hidden />
          <div className="space-y-1">
            <p className="text-sm font-medium">No contacts yet</p>
            <p className="text-sm text-muted-foreground">
              Upload phone numbers to build your audience.
            </p>
          </div>
          {canUpload ? (
            <Button onClick={() => setUploadOpen(true)}>
              <Plus className="size-4" aria-hidden /> Upload contacts
            </Button>
          ) : null}
        </div>
      ) : !listApi.isLoading && data.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-16 text-center">
          <p className="text-sm text-muted-foreground">
            {filters.view === "archived"
              ? "No archived contacts."
              : "No contacts match your filters."}
          </p>
          {filters.search ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                updateFilters({ search: "", page: 0 });
                setSearchInput("");
              }}
            >
              Clear search
            </Button>
          ) : null}
        </div>
      ) : (
        <DataTable<Contact>
          data={data}
          columns={columns}
          isLoading={listApi.isLoading}
          pageIndex={filters.page}
          pageSize={filters.pageSize}
          totalCount={totalCount}
          totalCountApprox={countApprox}
          hasMore={hasMore}
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
        />
      )}

      <FormDialog
        open={uploadOpen}
        onOpenChange={(open) => {
          setUploadOpen(open);
          if (!open) {
            setAssignMode("none");
            setAssignSegmentId(null);
          }
        }}
        className="max-h-[90vh] overflow-y-auto sm:max-w-xl"
      >
          <DialogHeader>
            <DialogTitle>Upload contacts</DialogTitle>
            <DialogDescription>
              Paste phone numbers or upload a CSV file.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 border-b pb-4">
            <Label>Assign to a segment</Label>
            <div className="grid gap-2 text-sm">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="assign-mode"
                  checked={assignMode === "none"}
                  onChange={() => {
                    setAssignMode("none");
                    setAssignSegmentId(null);
                  }}
                  className="size-4"
                />
                <span>Don&apos;t assign to a segment</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="assign-mode"
                  checked={assignMode === "segment"}
                  onChange={() => setAssignMode("segment")}
                  className="size-4"
                />
                <span>Add to a segment</span>
              </label>
              {assignMode === "segment" ? (
                <div className="pl-6">
                  <Select
                    value={
                      assignSegmentId !== null ? String(assignSegmentId) : ""
                    }
                    onValueChange={(v) => setAssignSegmentId(Number(v))}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Select a segment" />
                    </SelectTrigger>
                    <SelectContent>
                      {segmentsForAssign.map((s) => (
                        <SelectItem key={s.id} value={String(s.id)}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              Segments are independent of contact groups. The contact-groups
              picker below is required — every uploaded contact must be tagged
              with at least one group.
            </p>
          </div>

          {!uploadReady ? (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Pick a segment to enable upload.
            </p>
          ) : (
            <PhoneUploadForm
              endpoint="/api/contacts/upload"
              additionalFields={buildUploadFields()}
              onSuccess={handleUploadSuccess}
              onCancel={() => setUploadOpen(false)}
              submitLabel="Upload contacts"
              enableContactGroups
              requireContactGroups
              enableLookup
            />
          )}
      </FormDialog>

      {/* Import statuses dialog */}
      <FormDialog
        open={statusImportOpen}
        onOpenChange={setStatusImportOpen}
        className="max-h-[90vh] overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>Import contact statuses</DialogTitle>
          <DialogDescription>
            Update Opt-out, Suppressed, and Scrubbed statuses in bulk from a CSV.
            Statuses exclude contacts from future campaigns; campaigns already
            created keep their locked audience.
          </DialogDescription>
        </DialogHeader>
        <ContactStatusImportForm
          onSuccess={(summary) => {
            toast.success(
              `Applied ${summary.applied.toLocaleString()} status${
                summary.applied === 1 ? "" : "es"
              } across ${summary.contacts_affected.toLocaleString()} contact${
                summary.contacts_affected === 1 ? "" : "s"
              }`,
            );
            refetch();
          }}
          onCancel={() => setStatusImportOpen(false)}
        />
      </FormDialog>

      {/* Bulk apply-groups dialog */}
      <FormDialog
        open={applyOpen}
        onOpenChange={(o) => {
          if (!o) setApplyOpen(false);
        }}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>
            Apply contact groups to {selectedIds.size} contact
            {selectedIds.size === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            Existing memberships are kept. Each contact will be tagged with
            every selected group.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <MultiSelectPicker
            options={contactGroups.map((g) => ({
              id: g.id,
              label: g.name,
              color: g.color,
            }))}
            value={applyGroupIds}
            onChange={(next) => setApplyGroupIds(next as number[])}
            placeholder="Select groups to apply"
            selectedLabel={(n) =>
              `${n} group${n === 1 ? "" : "s"} selected`
            }
            isLoading={groupsApi.isLoading && contactGroups.length === 0}
            emptyMessage="No contact groups available. Create one first."
            searchPlaceholder="Search groups…"
          />
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => setApplyOpen(false)}
              disabled={bulkApplyApi.isLoading}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleApplyGroups()}
              disabled={
                bulkApplyApi.isLoading || applyGroupIds.length === 0
              }
            >
              Apply
            </Button>
          </div>
        </div>
      </FormDialog>

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
                ? "Archive this contact?"
                : confirming?.kind === "restore"
                  ? "Restore this contact?"
                  : "Delete this contact permanently?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.kind === "archive"
                ? "Archived contacts are hidden from the active list and excluded from new campaigns. Their data is preserved."
                : confirming?.kind === "restore"
                  ? "Restoring a contact moves them back into the active audience."
                  : "This permanently removes the contact and cannot be undone. Prefer archiving unless you specifically need to purge the record."}
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
              className={cn(
                confirming?.kind === "delete" &&
                  "bg-destructive text-destructive-foreground hover:bg-destructive/90",
              )}
            >
              {confirming?.kind === "archive"
                ? "Archive"
                : confirming?.kind === "restore"
                  ? "Restore"
                  : "Delete permanently"}
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
