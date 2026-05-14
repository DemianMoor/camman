"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  ArchiveRestore,
  Archive as ArchiveIcon,
  ArrowLeft,
  Check,
  Copy,
  Download,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/data-table";
import { ExportButton } from "@/components/export-button";
import {
  PhoneUploadForm,
  type UploadResultSummary,
} from "@/components/phone-upload-form";
import { useAuth } from "@/components/protected/auth-context";
import { RulesPanel } from "@/components/segments/rules-panel";
import {
  SegmentForm,
  type SegmentFormValues,
} from "@/components/segments/segment-form";
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
import { Card, CardContent } from "@/components/ui/card";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { formatPhoneInternational } from "@/lib/phone-validation";
import { cn } from "@/lib/utils";

type SegmentStats = {
  total_count: number;
  opt_out_count: number;
  opt_in_count: number;
  clicker_count: number;
  rule_filtered_count: number | null;
  updated_at: string | null;
};

type Segment = {
  id: number;
  segment_id: string;
  org_id: string;
  name: string;
  original_name: string | null;
  status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
  stats: SegmentStats;
  active_rules_count: number;
};

type ContactRow = {
  contact_id: string;
  phone_number: string;
  is_archived: boolean;
  joined_at: string;
  is_opt_out: boolean;
  is_opt_in: boolean;
  is_clicker: boolean;
  last_sent_at: string | null;
};

type ContactsResponse = {
  data: ContactRow[];
  totalCount: number;
};

type ContactsFilters = {
  search: string;
  page: number;
  pageSize: number;
  sortBy: string;
  sortDir: "asc" | "desc";
};

const DEFAULT_CONTACTS_FILTERS: ContactsFilters = {
  search: "",
  page: 0,
  pageSize: 20,
  sortBy: "created_at",
  sortDir: "desc",
};

const SEARCH_DEBOUNCE_MS = 300;

function StatusPill({ status }: { status: Segment["status"] }) {
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

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "neutral" | "red" | "green";
}) {
  const valueCls =
    tone === "red"
      ? "text-rose-700 dark:text-rose-400"
      : tone === "green"
        ? "text-emerald-700 dark:text-emerald-400"
        : "";
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("text-xl font-semibold tabular-nums", valueCls)}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

export default function SegmentDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const segmentIdNum = Number(params.id);
  const { auth, can } = useAuth();

  const segmentApi = useApiCall<Segment>();
  const updateApi = useApiCall<Segment>();
  const archiveApi = useApiCall<Segment>();
  const restoreApi = useApiCall<Segment>();
  const deleteApi = useApiCall<{ deleted: boolean }>();
  const refreshApi = useApiCall<SegmentStats>();
  const contactsApi = useApiCall<ContactsResponse>();
  const removeApi = useApiCall<{ submitted: number; removed: number; not_found: number }>();

  const [segment, setSegment] = useState<Segment | null>(null);
  const [segmentError, setSegmentError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refetchSegment = useCallback(() => setRefreshTick((n) => n + 1), []);

  useEffect(() => {
    if (!Number.isInteger(segmentIdNum) || segmentIdNum <= 0) return;
    let cancelled = false;
    setSegmentError(null);
    (async () => {
      const result = await segmentApi.execute(`/api/segments/${segmentIdNum}`);
      if (cancelled) return;
      if (result.ok) setSegment(result.data);
      else setSegmentError(result.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [segmentIdNum, refreshTick, segmentApi.execute]);

  const [filters, updateFilters, resetFilters] =
    usePersistedFilters<ContactsFilters>(
      `segment-detail.${segmentIdNum}.filters`,
      DEFAULT_CONTACTS_FILTERS,
    );
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

  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [contactsTotal, setContactsTotal] = useState(0);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [contactsTick, setContactsTick] = useState(0);
  const refetchContacts = useCallback(
    () => setContactsTick((n) => n + 1),
    [],
  );

  useEffect(() => {
    if (!Number.isInteger(segmentIdNum) || segmentIdNum <= 0) return;
    let cancelled = false;
    setContactsError(null);
    const sp = new URLSearchParams({
      page: String(filters.page),
      pageSize: String(filters.pageSize),
      sortBy: filters.sortBy,
      sortDir: filters.sortDir,
    });
    if (filters.search) sp.set("search", filters.search);
    (async () => {
      const result = await contactsApi.execute(
        `/api/segments/${segmentIdNum}/contacts?${sp.toString()}`,
      );
      if (cancelled) return;
      if (result.ok) {
        setContacts(result.data.data);
        setContactsTotal(result.data.totalCount);
      } else {
        setContactsError(result.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    segmentIdNum,
    filters.search,
    filters.sortBy,
    filters.sortDir,
    filters.page,
    filters.pageSize,
    contactsTick,
    contactsApi.execute,
  ]);

  const [editOpen, setEditOpen] = useState(false);
  const [confirming, setConfirming] = useState<
    "archive" | "restore" | "delete" | null
  >(null);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [bulkRemoveConfirm, setBulkRemoveConfirm] = useState(false);
  const [removePhonesValue, setRemovePhonesValue] = useState("");
  const [removeResult, setRemoveResult] = useState<{
    submitted: number;
    removed: number;
    not_found: number;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<
    "contacts" | "rules" | "upload" | "remove"
  >("contacts");

  const canUpdate = can("segments.update");
  const canArchive = can("segments.archive");
  const canRestore = can("segments.restore");
  const canDelete = can("segments.delete");
  const canUpload = can("segment_contacts.upload");
  const canRemove = can("segment_contacts.remove");
  const canViewRules = can("segment_rules.view");
  const canEditRules = can("segment_rules.update");

  function toggleRow(id: string) {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleEdit(values: SegmentFormValues) {
    if (!segment) return;
    const { segment_id: _omit, ...patch } = values;
    const result = await updateApi.execute(`/api/segments/${segment.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't save segment");
      return;
    }
    toast.success("Segment saved");
    setEditOpen(false);
    refetchSegment();
  }

  async function handleConfirm() {
    if (!segment || !confirming) return;
    if (confirming === "delete") {
      const result = await deleteApi.execute(`/api/segments/${segment.id}`, {
        method: "DELETE",
      });
      if (!result.ok) {
        toastApiError(result, "Couldn't delete segment");
        return;
      }
      toast.success("Segment deleted");
      setConfirming(null);
      router.push("/segments");
      return;
    }
    const isArchive = confirming === "archive";
    const api = isArchive ? archiveApi : restoreApi;
    const result = await api.execute(
      `/api/segments/${segment.id}/${isArchive ? "archive" : "restore"}`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    toast.success(isArchive ? "Segment archived" : "Segment restored");
    setConfirming(null);
    refetchSegment();
  }

  async function handleRefreshStats() {
    if (!segment) return;
    const result = await refreshApi.execute(
      `/api/segments/${segment.id}/refresh-stats`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't refresh stats");
      return;
    }
    toast.success("Stats refreshed");
    refetchSegment();
  }

  function handleUploadSuccess(summary: UploadResultSummary) {
    toast.success(
      `Added ${summary.inserted.toLocaleString()} contact${summary.inserted === 1 ? "" : "s"} to segment`,
    );
    refetchSegment();
    refetchContacts();
  }

  async function handleBulkRemove() {
    if (!segment) return;
    // Build phone list from selected contact rows.
    const phones = contacts
      .filter((c) => selectedRows.has(c.contact_id))
      .map((c) => c.phone_number);
    if (phones.length === 0) return;
    const result = await removeApi.execute(
      `/api/segments/${segment.id}/contacts/remove`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phones: phones.join("\n") }),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't remove contacts");
      return;
    }
    toast.success(`Removed ${result.data.removed} contacts from segment`);
    setBulkRemoveConfirm(false);
    setSelectedRows(new Set());
    refetchSegment();
    refetchContacts();
  }

  async function handleRemovePhonesSubmit() {
    if (!segment || !removePhonesValue.trim()) return;
    const result = await removeApi.execute(
      `/api/segments/${segment.id}/contacts/remove`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phones: removePhonesValue }),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't remove contacts");
      return;
    }
    setRemoveResult(result.data);
    setRemovePhonesValue("");
    refetchSegment();
    refetchContacts();
  }

  const columns = useMemo<ColumnDef<ContactRow>[]>(
    () => [
      {
        id: "select",
        header: () => null,
        enableSorting: false,
        cell: ({ row }) => (
          <input
            type="checkbox"
            checked={selectedRows.has(row.original.contact_id)}
            onClick={(e) => e.stopPropagation()}
            onChange={() => toggleRow(row.original.contact_id)}
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
        id: "last_sent_at",
        header: "Last Sent",
        enableSorting: false,
        cell: () => <span className="text-muted-foreground">—</span>,
      },
      {
        id: "opt_out",
        header: "Opt-Out",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.is_opt_out ? (
            <Badge className="border-rose-200 bg-rose-100 text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">
              Yes
            </Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "opt_in",
        header: "Opt-In",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.is_opt_in ? (
            <Badge className="border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
              Yes
            </Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "clicker",
        header: "Clicker",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.is_clicker ? (
            <Badge variant="secondary">Yes</Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "joined_at",
        header: "Joined",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {format(new Date(row.original.joined_at), "MMM d, yyyy")}
          </span>
        ),
        enableSorting: true,
      },
    ],
    [selectedRows],
  );

  if (!auth) return null;

  if (segmentError) {
    return (
      <div className="space-y-4">
        <Link
          href="/segments"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3" aria-hidden /> All segments
        </Link>
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">{segmentError}</p>
        </div>
      </div>
    );
  }

  if (!segment) {
    return (
      <div className="space-y-4">
        <Link
          href="/segments"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3" aria-hidden /> All segments
        </Link>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href="/segments"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3" aria-hidden /> All segments
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {segment.name}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-xs text-muted-foreground">
              {segment.segment_id}
            </span>
            <StatusPill status={segment.status} />
            {segment.original_name && segment.original_name !== segment.name ? (
              <span className="text-xs text-muted-foreground">
                Formerly: {segment.original_name}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canUpdate ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditOpen(true)}
            >
              <Pencil className="size-4" aria-hidden /> Edit
            </Button>
          ) : null}
          {canUpdate ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefreshStats}
              disabled={refreshApi.isLoading}
            >
              <RefreshCw className="size-4" aria-hidden /> Refresh stats
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              window.open(
                `/api/segments/${segment.id}/export-contacts`,
                "_blank",
                "noopener",
              )
            }
            title="Export the segment's full audience (manual + rule-matched) as CSV"
          >
            <Download className="size-4" aria-hidden /> Export contacts
          </Button>
          {segment.status === "active" && canArchive ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirming("archive")}
            >
              <ArchiveIcon className="size-4" aria-hidden /> Archive
            </Button>
          ) : null}
          {segment.status === "archived" && canRestore ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirming("restore")}
            >
              <ArchiveRestore className="size-4" aria-hidden /> Restore
            </Button>
          ) : null}
          {canDelete ? (
            <Button
              variant="outline"
              size="sm"
              className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setConfirming("delete")}
            >
              <Trash2 className="size-4" aria-hidden /> Delete
            </Button>
          ) : null}
        </div>
      </header>

      <Card>
        <CardContent
          className={cn(
            "grid grid-cols-2 gap-3 pt-6",
            segment.active_rules_count > 0
              ? "sm:grid-cols-6"
              : "sm:grid-cols-5",
          )}
        >
          <StatCard label="Total contacts" value={segment.stats.total_count} />
          {segment.active_rules_count > 0 ? (
            <StatCard
              label="Rule-filtered"
              value={
                segment.stats.rule_filtered_count !== null
                  ? segment.stats.rule_filtered_count
                  : "—"
              }
            />
          ) : null}
          <StatCard
            label="Opt-Outs"
            value={segment.stats.opt_out_count}
            tone="red"
          />
          <StatCard
            label="Opt-Ins"
            value={segment.stats.opt_in_count}
            tone="green"
          />
          <StatCard label="Clickers" value={segment.stats.clicker_count} />
          <StatCard
            label="Updated"
            value={
              segment.stats.updated_at
                ? format(new Date(segment.stats.updated_at), "MMM d, HH:mm")
                : "—"
            }
          />
        </CardContent>
      </Card>

      <Tabs
        value={activeTab}
        onValueChange={(v) =>
          setActiveTab(v as "contacts" | "rules" | "upload" | "remove")
        }
        className="space-y-4"
      >
        <TabsList>
          <TabsTrigger value="contacts">Contacts</TabsTrigger>
          {canViewRules ? (
            <TabsTrigger value="rules">
              Rules
              {segment.active_rules_count > 0 ? (
                <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-xs">
                  {segment.active_rules_count}
                </Badge>
              ) : null}
            </TabsTrigger>
          ) : null}
          {canUpload ? (
            <TabsTrigger value="upload">Upload Phones</TabsTrigger>
          ) : null}
          {canRemove ? (
            <TabsTrigger value="remove">Remove Phones</TabsTrigger>
          ) : null}
        </TabsList>

        <TabsContent value="contacts" className="space-y-3">
          {segment.active_rules_count > 0 ? (
            <div className="rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-100">
              <span className="font-medium">Manual members only.</span> This
              segment has{" "}
              <span className="font-medium">
                {segment.active_rules_count} active rule
                {segment.active_rules_count === 1 ? "" : "s"}
              </span>{" "}
              that add{segment.active_rules_count === 1 ? "s" : ""}{" "}
              {segment.stats.rule_filtered_count !== null &&
              segment.stats.rule_filtered_count > segment.stats.total_count
                ? `${(segment.stats.rule_filtered_count - segment.stats.total_count).toLocaleString()} more contact${segment.stats.rule_filtered_count - segment.stats.total_count === 1 ? "" : "s"} to the audience`
                : "more contacts to the audience"}
              . Open the <span className="font-medium">Rules</span> tab to view
              or change them. Rule-matched contacts can't be removed
              individually here — change the rule instead.
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by phone…"
              className="h-9 w-full max-w-sm"
            />
            {filters.search !== DEFAULT_CONTACTS_FILTERS.search ? (
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
                endpoint={`/api/segments/${segment.id}/contacts/export`}
                permission="segments.view"
                filenamePrefix={`segment-${segment.segment_id}-contacts`}
                queryParams={{
                  search: filters.search || undefined,
                  sortBy: filters.sortBy,
                  sortDir: filters.sortDir,
                }}
                disabledIfEmpty={contactsTotal}
              />
            </div>
          </div>

          {selectedRows.size > 0 ? (
            <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <div>
                <span className="font-medium">{selectedRows.size}</span>{" "}
                selected
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedRows(new Set())}
                >
                  Clear
                </Button>
                {canRemove ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setBulkRemoveConfirm(true)}
                  >
                    <X className="size-4" aria-hidden /> Remove from segment
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {contactsError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
              <p className="text-destructive">{contactsError}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={refetchContacts}
              >
                Retry
              </Button>
            </div>
          ) : !contactsApi.isLoading && contacts.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed py-12 text-center">
              <p className="text-sm font-medium">No contacts in this segment</p>
              <p className="text-sm text-muted-foreground">
                Use the Upload tab to add phone numbers.
              </p>
            </div>
          ) : (
            <DataTable<ContactRow>
              data={contacts}
              columns={columns}
              isLoading={contactsApi.isLoading}
              pageIndex={filters.page}
              pageSize={filters.pageSize}
              totalCount={contactsTotal}
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
        </TabsContent>

        {canViewRules ? (
          <TabsContent value="rules" className="space-y-3">
            <RulesPanel
              segmentId={segment.id}
              currentSegmentDbId={segment.id}
              canEdit={canEditRules}
              manualCount={segment.stats.total_count}
            />
          </TabsContent>
        ) : null}

        {canUpload ? (
          <TabsContent value="upload" className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Contacts already in your registry are reused; new phones are added
              to Contacts and assigned to this segment.
            </p>
            <PhoneUploadForm
              endpoint={`/api/segments/${segment.id}/contacts/upload`}
              onSuccess={handleUploadSuccess}
              onCancel={() => setActiveTab("contacts")}
              submitLabel="Add to segment"
              successLabel="Contacts added to segment"
            />
          </TabsContent>
        ) : null}

        {canRemove ? (
          <TabsContent value="remove" className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Paste phone numbers to remove from this segment. Removing a
              contact here doesn&apos;t delete the contact — it just unassigns
              them from the segment.
            </p>
            <div className="grid gap-2">
              <Label htmlFor="remove-phones">Phone numbers</Label>
              <Textarea
                id="remove-phones"
                rows={10}
                placeholder="+1 202 555 0199&#10;+1 202 555 0200&#10;..."
                value={removePhonesValue}
                onChange={(e) => setRemovePhonesValue(e.target.value)}
                className="font-mono text-sm"
                disabled={removeApi.isLoading}
              />
              <p className="text-xs text-muted-foreground">
                One phone per line. Commas and semicolons also work.
              </p>
            </div>
            <div className="flex items-center justify-end">
              <Button
                onClick={handleRemovePhonesSubmit}
                disabled={
                  removeApi.isLoading || removePhonesValue.trim().length === 0
                }
              >
                Remove from segment
              </Button>
            </div>
            {removeResult ? (
              <div className="rounded-md border bg-muted/40 p-3 text-sm">
                <p>
                  Removed{" "}
                  <span className="font-medium">{removeResult.removed}</span> of{" "}
                  <span className="font-medium">{removeResult.submitted}</span>{" "}
                  submitted (
                  <span className="text-muted-foreground">
                    {removeResult.not_found} not found in this segment
                  </span>
                  ).
                </p>
              </div>
            ) : null}
          </TabsContent>
        ) : null}
      </Tabs>

      {/* Edit segment dialog */}
      <FormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Edit segment</DialogTitle>
          <DialogDescription>{segment.name}</DialogDescription>
        </DialogHeader>
        <SegmentForm
          key={`edit-${segment.id}`}
          mode="edit"
          initialValues={{
            name: segment.name,
            segment_id: segment.segment_id,
            original_name: segment.original_name ?? "",
          }}
          onSubmit={handleEdit}
          onCancel={() => setEditOpen(false)}
          isSubmitting={updateApi.isLoading}
        />
      </FormDialog>

      {/* Archive / Restore / Delete confirm */}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming === "archive"
                ? "Archive this segment?"
                : confirming === "restore"
                  ? "Restore this segment?"
                  : "Delete this segment permanently?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming === "archive"
                ? "Archived segments are hidden but their membership is preserved."
                : confirming === "restore"
                  ? "Restoring a segment moves it back into the active list."
                  : "This permanently removes the segment and its membership. Cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={
                archiveApi.isLoading ||
                restoreApi.isLoading ||
                deleteApi.isLoading
              }
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleConfirm();
              }}
              disabled={
                archiveApi.isLoading ||
                restoreApi.isLoading ||
                deleteApi.isLoading
              }
              className={
                confirming === "delete"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : ""
              }
            >
              {confirming === "archive"
                ? "Archive"
                : confirming === "restore"
                  ? "Restore"
                  : "Delete permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk remove confirm */}
      <AlertDialog
        open={bulkRemoveConfirm}
        onOpenChange={setBulkRemoveConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {selectedRows.size} contact
              {selectedRows.size === 1 ? "" : "s"} from segment?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Removes the selected contacts from this segment. The contacts
              themselves remain in your registry.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeApi.isLoading}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleBulkRemove();
              }}
              disabled={removeApi.isLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove from segment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
