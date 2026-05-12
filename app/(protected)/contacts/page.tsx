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
  Trash2,
  Users,
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

type Contact = {
  id: string;
  org_id: string;
  phone_number: string;
  is_archived: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type ContactView = "active" | "archived" | "opt_outs" | "opt_ins" | "clickers";

type ListResponse = {
  data: Contact[];
  totalCount: number;
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

type Filters = {
  search: string;
  view: ContactView;
  page: number;
  pageSize: number;
  sortBy: string;
  sortDir: "asc" | "desc";
};

const DEFAULT_FILTERS: Filters = {
  search: "",
  view: "active",
  page: 0,
  pageSize: 20,
  sortBy: "created_at",
  sortDir: "desc",
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

export default function ContactsPage() {
  const { auth, can } = useAuth();

  const [filters, updateFilters, resetFilters] = usePersistedFilters<Filters>(
    "contacts.filters",
    DEFAULT_FILTERS,
  );
  const filtersAreDefault =
    filters.search === DEFAULT_FILTERS.search &&
    filters.view === DEFAULT_FILTERS.view;

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
  const archiveApi = useApiCall<Contact>();
  const restoreApi = useApiCall<Contact>();
  const deleteApi = useApiCall<{ ok: true; id: string }>();

  const [data, setData] = useState<Contact[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [stats, setStats] = useState<BaseStats | null>(null);
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
      view: filters.view,
    });
    if (filters.search) params.set("search", filters.search);

    (async () => {
      const result = await listApi.execute(
        `/api/contacts/list?${params.toString()}`,
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
    filters.view,
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

  const [uploadOpen, setUploadOpen] = useState(false);
  type AssignMode = "none" | "segment" | "group";
  const [assignMode, setAssignMode] = useState<AssignMode>("none");
  const [assignSegmentId, setAssignSegmentId] = useState<number | null>(null);
  const [assignGroupId, setAssignGroupId] = useState<number | null>(null);
  const [segmentsForAssign, setSegmentsForAssign] = useState<
    { id: number; name: string }[]
  >([]);
  const [groupsForAssign, setGroupsForAssign] = useState<
    { id: number; name: string; color: string | null }[]
  >([]);
  const segmentsAssignApi = useApiCall<{
    data: { id: number; name: string }[];
  }>();
  const groupsAssignApi = useApiCall<{
    data: { id: number; name: string; color: string | null }[];
  }>();

  // Lazy-load the pickers when the user opens the upload dialog so we don't
  // fetch them on every contacts page render.
  useEffect(() => {
    if (!uploadOpen) return;
    (async () => {
      const r = await segmentsAssignApi.execute(
        "/api/segments/list?pageSize=100&sortBy=name&sortDir=asc",
      );
      if (r.ok) setSegmentsForAssign(r.data.data);
    })();
    (async () => {
      const r = await groupsAssignApi.execute(
        "/api/segment-groups/list?pageSize=100&sortBy=name&sortDir=asc",
      );
      if (r.ok) setGroupsForAssign(r.data.data);
    })();
  }, [uploadOpen, segmentsAssignApi.execute, groupsAssignApi.execute]);

  const [confirming, setConfirming] = useState<
    | { kind: "archive"; contact: Contact }
    | { kind: "restore"; contact: Contact }
    | { kind: "delete"; contact: Contact }
    | null
  >(null);

  const canUpload = can("contacts.upload");
  const canArchive = can("contacts.archive");
  const canDelete = can("contacts.delete");

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

  // Snapshot the additional fields the upload form will POST. Only includes the
  // active assignment branch (segment XOR group XOR none).
  function buildUploadFields(): Record<string, unknown> {
    if (assignMode === "segment" && assignSegmentId !== null) {
      return { assign_to_segment_id: assignSegmentId };
    }
    if (assignMode === "group" && assignGroupId !== null) {
      return { assign_to_segment_group_id: assignGroupId };
    }
    return {};
  }

  const uploadReady =
    assignMode === "none" ||
    (assignMode === "segment" && assignSegmentId !== null) ||
    (assignMode === "group" && assignGroupId !== null);

  const columns = useMemo<ColumnDef<Contact>[]>(
    () => [
      {
        id: "phone_number",
        header: "Phone Number",
        cell: ({ row }) => <PhoneCell contact={row.original} />,
        enableSorting: true,
      },
      {
        id: "indicators",
        header: "Status indicators",
        enableSorting: false,
        cell: () => <span className="text-muted-foreground">—</span>,
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
    [canArchive, canDelete],
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
        {canUpload ? (
          <Button onClick={() => setUploadOpen(true)}>
            <Plus className="size-4" aria-hidden /> Upload contacts
          </Button>
        ) : null}
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

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={`Search ${VIEW_LABELS[filters.view]} by phone…`}
          className="h-9 w-full max-w-sm"
        />
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

      <Dialog
        open={uploadOpen}
        onOpenChange={(open) => {
          setUploadOpen(open);
          if (!open) {
            setAssignMode("none");
            setAssignSegmentId(null);
            setAssignGroupId(null);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Upload contacts</DialogTitle>
            <DialogDescription>
              Paste phone numbers or upload a CSV file.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 border-b pb-4">
            <Label>Assign to</Label>
            <div className="grid gap-2 text-sm">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="assign-mode"
                  checked={assignMode === "none"}
                  onChange={() => {
                    setAssignMode("none");
                    setAssignSegmentId(null);
                    setAssignGroupId(null);
                  }}
                  className="size-4"
                />
                <span>Don&apos;t assign</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="assign-mode"
                  checked={assignMode === "segment"}
                  onChange={() => {
                    setAssignMode("segment");
                    setAssignGroupId(null);
                  }}
                  className="size-4"
                />
                <span>Assign to a segment</span>
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
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="assign-mode"
                  checked={assignMode === "group"}
                  onChange={() => {
                    setAssignMode("group");
                    setAssignSegmentId(null);
                  }}
                  className="size-4"
                />
                <span>Assign to a segment group</span>
              </label>
              {assignMode === "group" ? (
                <div className="pl-6">
                  <Select
                    value={assignGroupId !== null ? String(assignGroupId) : ""}
                    onValueChange={(v) => setAssignGroupId(Number(v))}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Select a segment group" />
                    </SelectTrigger>
                    <SelectContent>
                      {groupsForAssign.map((g) => (
                        <SelectItem key={g.id} value={String(g.id)}>
                          {g.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Contacts will be added to every active segment in this
                    group.
                  </p>
                </div>
              ) : null}
            </div>
          </div>

          {!uploadReady ? (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Pick a {assignMode === "segment" ? "segment" : "group"} to enable
              upload.
            </p>
          ) : (
            <PhoneUploadForm
              endpoint="/api/contacts/upload"
              additionalFields={buildUploadFields()}
              onSuccess={handleUploadSuccess}
              onCancel={() => setUploadOpen(false)}
              submitLabel="Upload contacts"
            />
          )}
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
