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
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/data-table";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
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
  exclude_in_use_contacts: boolean;
  stats: SegmentStats;
  active_rules_count: number;
};

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

// Read-only paginated view of the segment's full UNION audience. Mounts
// when the user opens the Audience tab. Search + membership filter are
// stored in component state (not localStorage) since this tab is
// typically a one-off audit, not a recurring view.
function AudiencePanel({
  segmentId,
  segmentSlug,
}: {
  segmentId: number;
  segmentSlug: string;
}) {
  type AudienceRow = {
    contact_id: string;
    phone: string;
    joined_at: string | null;
    membership_type: "manual" | "rule-matched";
    other_groups: { id: number; name: string; color: string | null }[];
  };
  type AudienceResponse = {
    data: AudienceRow[];
    totalCount: number;
    page: number;
    pageSize: number;
    counts: { manual: number; rule_matched: number; total: number };
  };

  const audienceApi = useApiCall<AudienceResponse>();
  const [data, setData] = useState<AudienceRow[]>([]);
  const [counts, setCounts] = useState<AudienceResponse["counts"]>({
    manual: 0,
    rule_matched: 0,
    total: 0,
  });
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [membership, setMembership] = useState<
    "all" | "manual" | "rule-matched"
  >("all");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const fetchAudience = useCallback(async () => {
    const qs = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    });
    if (debouncedSearch) qs.set("search", debouncedSearch);
    if (membership !== "all") qs.set("membership_type", membership);
    const r = await audienceApi.execute(
      `/api/segments/${segmentId}/audience?${qs.toString()}`,
    );
    if (r.ok) {
      setData(r.data.data);
      setTotalCount(r.data.totalCount);
      setCounts(r.data.counts);
    }
  }, [audienceApi.execute, segmentId, page, pageSize, debouncedSearch, membership]);

  useEffect(() => {
    fetchAudience();
  }, [fetchAudience]);

  const audienceColumns = useMemo<ColumnDef<AudienceRow>[]>(
    () => [
      {
        id: "phone",
        header: "Phone",
        enableSorting: false,
        cell: ({ row }) => <PhoneCell phone={row.original.phone} />,
      },
      {
        id: "membership",
        header: "Membership",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.membership_type === "manual" ? (
            <Badge variant="secondary">Manual</Badge>
          ) : (
            <Badge
              className="border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-200"
              title="Pulled in by an active rule"
            >
              Rule-matched
            </Badge>
          ),
      },
      {
        id: "joined_at",
        header: "Joined",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.joined_at ? (
            <span className="text-muted-foreground">
              {format(new Date(row.original.joined_at), "MMM d, yyyy")}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "other_groups",
        header: "Other groups",
        enableSorting: false,
        cell: ({ row }) => {
          const groups = row.original.other_groups;
          if (groups.length === 0)
            return <span className="text-muted-foreground">—</span>;
          return (
            <div className="flex flex-wrap gap-1">
              {groups.map((g) => (
                <span
                  key={g.id}
                  className="inline-flex items-center gap-1 rounded-full border border-muted bg-muted/40 px-1.5 py-0.5 text-xs"
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: g.color ?? "#64748B" }}
                  />
                  {g.name}
                </span>
              ))}
            </div>
          );
        },
      },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      <div className="rounded-md border bg-background p-3 text-sm">
        <span className="text-muted-foreground">Manual:</span>{" "}
        <span className="font-mono tabular-nums">
          {counts.manual.toLocaleString()}
        </span>
        <span className="mx-2 text-muted-foreground">·</span>
        <span className="text-muted-foreground">Rule-matched:</span>{" "}
        <span className="font-mono tabular-nums">
          {counts.rule_matched.toLocaleString()}
        </span>
        <span className="mx-2 text-muted-foreground">·</span>
        <span className="font-medium">Total audience:</span>{" "}
        <span className="font-mono tabular-nums font-semibold">
          {counts.total.toLocaleString()}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          placeholder="Search by phone…"
          className="h-9 w-full max-w-sm"
        />
        <Select
          value={membership}
          onValueChange={(v) => {
            setMembership(v as "all" | "manual" | "rule-matched");
            setPage(0);
          }}
        >
          <SelectTrigger className="h-9 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All members</SelectItem>
            <SelectItem value="manual">Manual only</SelectItem>
            <SelectItem value="rule-matched">Rule-matched only</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              window.open(
                `/api/segments/${segmentId}/export-contacts`,
                "_blank",
                "noopener",
              )
            }
            title={`Export segment ${segmentSlug} audience CSV`}
          >
            <Download className="size-4" aria-hidden /> Export CSV
          </Button>
        </div>
      </div>

      <DataTable<AudienceRow>
        data={data}
        columns={audienceColumns}
        isLoading={audienceApi.isLoading}
        pageIndex={page}
        pageSize={pageSize}
        totalCount={totalCount}
        onPageChange={setPage}
        onPageSizeChange={(s) => {
          setPageSize(s);
          setPage(0);
        }}
        sortBy={null}
        sortDir="asc"
        onSortChange={() => undefined}
      />
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

  const [editOpen, setEditOpen] = useState(false);
  const [confirming, setConfirming] = useState<
    "archive" | "restore" | "delete" | null
  >(null);
  const [removePhonesValue, setRemovePhonesValue] = useState("");
  const [removeResult, setRemoveResult] = useState<{
    submitted: number;
    removed: number;
    not_found: number;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<
    "audience" | "rules" | "upload" | "remove"
  >("audience");

  const canUpdate = can("segments.update");
  const canArchive = can("segments.archive");
  const canRestore = can("segments.restore");
  const canDelete = can("segments.delete");
  const canUpload = can("segment_contacts.upload");
  const canRemove = can("segment_contacts.remove");
  const canViewRules = can("segment_rules.view");
  const canEditRules = can("segment_rules.update");

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
  }

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
          <StatCard
            label={
              segment.active_rules_count > 0
                ? "Manual members"
                : "Total contacts"
            }
            value={segment.stats.total_count}
          />
          {segment.active_rules_count > 0 ? (
            <StatCard
              label="Audience (manual + rules)"
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
          setActiveTab(
            v as "audience" | "rules" | "upload" | "remove",
          )
        }
        className="space-y-4"
      >
        <TabsList>
          <TabsTrigger value="audience">Audience</TabsTrigger>
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

        <TabsContent value="audience" className="space-y-3">
          <AudiencePanel segmentId={segment.id} segmentSlug={segment.segment_id} />
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
              onCancel={() => setActiveTab("audience")}
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
            exclude_in_use_contacts: segment.exclude_in_use_contacts,
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

    </div>
  );
}
