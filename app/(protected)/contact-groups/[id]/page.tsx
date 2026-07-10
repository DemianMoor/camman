"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  ArchiveRestore,
  Archive as ArchiveIcon,
  ArrowLeft,
  Check,
  Copy,
  Pencil,
  X,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import {
  ContactGroupForm,
  type ContactGroupFormValues,
} from "@/components/contact-groups/contact-group-form";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { formatPhoneInternational } from "@/lib/phone-validation";
import { cn } from "@/lib/utils";

type ContactGroup = {
  id: number;
  contact_group_id: string;
  org_id: string;
  name: string;
  description: string | null;
  color: string | null;
  status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
};

type GroupContactRow = {
  id: string;
  phone_number: string;
  is_archived: boolean;
  created_at: string;
  joined_at: string;
  other_groups: { id: number; name: string; color: string | null }[];
};

type ContactsResponse = {
  data: GroupContactRow[];
  totalCount: number;
};

type ContactsFilters = {
  search: string;
  page: number;
  pageSize: number;
  sortBy: string;
  sortDir: "asc" | "desc";
};

const DEFAULT_FILTERS: ContactsFilters = {
  search: "",
  page: 0,
  pageSize: 20,
  sortBy: "joined_at",
  sortDir: "desc",
};

const SEARCH_DEBOUNCE_MS = 300;

function StatusPill({ status }: { status: ContactGroup["status"] }) {
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

export default function ContactGroupDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const groupIdNum = Number(params.id);
  const { auth, can } = useAuth();

  const groupApi = useApiCall<ContactGroup>();
  const updateApi = useApiCall<ContactGroup>();
  const archiveApi = useApiCall<ContactGroup>();
  const restoreApi = useApiCall<ContactGroup>();
  const contactsApi = useApiCall<ContactsResponse>();
  const removeApi = useApiCall<{
    submitted: number;
    removed: number;
    not_in_group: number;
    not_found: number;
  }>();
  const bulkRemoveApi = useApiCall<{ applied: number }>();

  const [group, setGroup] = useState<ContactGroup | null>(null);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refetchGroup = useCallback(() => setRefreshTick((n) => n + 1), []);

  useEffect(() => {
    if (!Number.isInteger(groupIdNum) || groupIdNum <= 0) return;
    let cancelled = false;
    setGroupError(null);
    (async () => {
      const r = await groupApi.execute(`/api/contact-groups/${groupIdNum}`);
      if (cancelled) return;
      if (r.ok) setGroup(r.data);
      else setGroupError(r.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [groupIdNum, refreshTick, groupApi.execute]);

  const [filters, updateFilters, resetFilters] =
    usePersistedFilters<ContactsFilters>(
      `contact-group.${groupIdNum}.filters`,
      DEFAULT_FILTERS,
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

  const [contacts, setContacts] = useState<GroupContactRow[]>([]);
  const [contactsTotal, setContactsTotal] = useState(0);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [contactsTick, setContactsTick] = useState(0);
  const refetchContacts = useCallback(
    () => setContactsTick((n) => n + 1),
    [],
  );

  useEffect(() => {
    if (!Number.isInteger(groupIdNum) || groupIdNum <= 0) return;
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
      const r = await contactsApi.execute(
        `/api/contact-groups/${groupIdNum}/contacts?${sp.toString()}`,
      );
      if (cancelled) return;
      if (r.ok) {
        setContacts(r.data.data);
        setContactsTotal(r.data.totalCount);
      } else {
        setContactsError(r.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    groupIdNum,
    filters.search,
    filters.sortBy,
    filters.sortDir,
    filters.page,
    filters.pageSize,
    contactsTick,
    contactsApi.execute,
  ]);

  const [editOpen, setEditOpen] = useState(false);
  const [confirming, setConfirming] = useState<"archive" | "restore" | null>(
    null,
  );
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [bulkRemoveConfirm, setBulkRemoveConfirm] = useState(false);
  const [activeTab, setActiveTab] = useState<"contacts" | "add" | "remove">(
    "contacts",
  );

  const canUpdate = can("contact_groups.update");
  const canArchive = can("contact_groups.archive");
  const canRestore = can("contact_groups.restore");
  const canManageMembers = can("contact_contact_groups.manage");

  function toggleRow(id: string) {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleEdit(values: ContactGroupFormValues) {
    if (!group) return;
    const { contact_group_id: _omit, ...patch } = values;
    const result = await updateApi.execute(`/api/contact-groups/${group.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!result.ok) {
      toastApiError(result, "Couldn't save contact group");
      return;
    }
    toast.success("Contact group saved");
    setEditOpen(false);
    refetchGroup();
  }

  async function handleConfirm() {
    if (!group || !confirming) return;
    const api = confirming === "archive" ? archiveApi : restoreApi;
    const result = await api.execute(
      `/api/contact-groups/${group.id}/${confirming}`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    toast.success(
      confirming === "archive" ? "Contact group archived" : "Contact group restored",
    );
    setConfirming(null);
    refetchGroup();
  }

  function handleAddSuccess(summary: UploadResultSummary) {
    const addedToGroup =
      typeof summary.groups_applied === "number"
        ? summary.groups_applied
        : summary.inserted;
    toast.success(
      `Added ${addedToGroup.toLocaleString()} contact${addedToGroup === 1 ? "" : "s"} to this group`,
    );
    refetchContacts();
  }

  async function handleBulkRemove() {
    if (!group) return;
    const phones = contacts
      .filter((c) => selectedRows.has(c.id))
      .map((c) => c.phone_number);
    if (phones.length === 0) return;
    const r = await removeApi.execute(
      `/api/contact-groups/${group.id}/contacts/remove`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phones: phones.join("\n") }),
      },
    );
    if (!r.ok) {
      toastApiError(r, "Couldn't remove contacts");
      return;
    }
    toast.success(`Removed ${r.data.removed} from this group`);
    setBulkRemoveConfirm(false);
    setSelectedRows(new Set());
    refetchContacts();
  }

  const columns = useMemo<ColumnDef<GroupContactRow>[]>(
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
        id: "status",
        header: "Status",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.is_archived ? (
            <Badge variant="secondary">Archived</Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "other_groups",
        header: "Other Groups",
        enableSorting: false,
        cell: ({ row }) => {
          const gs = row.original.other_groups;
          if (!gs || gs.length === 0)
            return <span className="text-muted-foreground">—</span>;
          const visible = gs.slice(0, 2);
          const overflow = gs.slice(2);
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
  void router;
  void bulkRemoveApi;

  if (groupError) {
    return (
      <div className="space-y-4">
        <Link
          href="/contact-groups"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3" aria-hidden /> All contact groups
        </Link>
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">{groupError}</p>
        </div>
      </div>
    );
  }

  if (!group) {
    return (
      <div className="space-y-4">
        <Link
          href="/contact-groups"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3" aria-hidden /> All contact groups
        </Link>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href="/contact-groups"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3" aria-hidden /> All contact groups
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span
              className="size-3 rounded-full"
              style={{ backgroundColor: group.color ?? "#64748B" }}
            />
            <h1 className="text-2xl font-semibold tracking-tight">
              {group.name}
            </h1>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-xs text-muted-foreground">
              {group.contact_group_id}
            </span>
            <StatusPill status={group.status} />
            {group.description ? (
              <span className="text-xs text-muted-foreground">
                {group.description}
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
          {group.status === "active" && canArchive ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirming("archive")}
            >
              <ArchiveIcon className="size-4" aria-hidden /> Archive
            </Button>
          ) : null}
          {group.status === "archived" && canRestore ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirming("restore")}
            >
              <ArchiveRestore className="size-4" aria-hidden /> Restore
            </Button>
          ) : null}
        </div>
      </header>

      <Card>
        <CardContent className="grid grid-cols-1 gap-3 pt-6 sm:grid-cols-3">
          <div className="rounded-md border bg-background p-3">
            <div className="text-xs text-muted-foreground">Contacts in group</div>
            <div className="text-xl font-semibold tabular-nums">
              {contactsTotal.toLocaleString()}
            </div>
          </div>
          <div className="rounded-md border bg-background p-3">
            <div className="text-xs text-muted-foreground">Created</div>
            <div className="text-base font-medium tabular-nums">
              {format(new Date(group.created_at), "MMM d, yyyy")}
            </div>
          </div>
          <div className="rounded-md border bg-background p-3">
            <div className="text-xs text-muted-foreground">Status</div>
            <div className="text-base font-medium capitalize">
              {group.status}
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as typeof activeTab)}
        className="space-y-4"
      >
        <TabsList>
          <TabsTrigger value="contacts">Contacts</TabsTrigger>
          {canManageMembers ? (
            <TabsTrigger value="add">Add contacts</TabsTrigger>
          ) : null}
          {canManageMembers ? (
            <TabsTrigger value="remove">Remove contacts</TabsTrigger>
          ) : null}
        </TabsList>

        <TabsContent value="contacts" className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by phone…"
              className="h-9 w-full max-w-sm"
            />
            {filters.search !== DEFAULT_FILTERS.search ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  resetFilters();
                  setSearchInput("");
                }}
              >
                Reset
              </Button>
            ) : null}
          </div>

          {selectedRows.size > 0 ? (
            <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <div>
                <span className="font-medium">{selectedRows.size}</span> selected
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedRows(new Set())}
                >
                  Clear
                </Button>
                {canManageMembers ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setBulkRemoveConfirm(true)}
                  >
                    <X className="size-4" aria-hidden /> Remove from group
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
              <p className="text-sm font-medium">
                No contacts in this group yet
              </p>
              <p className="text-sm text-muted-foreground">
                Use the Add contacts tab to tag phone numbers with this group.
              </p>
            </div>
          ) : (
            <DataTable<GroupContactRow>
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
                  sortBy: by ?? "joined_at",
                  sortDir: dir,
                  page: 0,
                })
              }
            />
          )}
        </TabsContent>

        {canManageMembers ? (
          <TabsContent value="add" className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Existing contacts are tagged; new phones are added to Contacts
              first, then tagged.
            </p>
            <PhoneUploadForm
              endpoint={`/api/contact-groups/${group.id}/contacts/add`}
              onSuccess={handleAddSuccess}
              onCancel={() => setActiveTab("contacts")}
              submitLabel="Add to group"
              successLabel="Contacts added to group"
              enableLookup
            />
          </TabsContent>
        ) : null}

        {canManageMembers ? (
          <TabsContent value="remove" className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Paste phone numbers to remove their group membership. The
              contacts themselves remain in your registry.
            </p>
            <PhoneUploadForm
              endpoint={`/api/contact-groups/${group.id}/contacts/remove`}
              onSuccess={() => {
                refetchContacts();
              }}
              onCancel={() => setActiveTab("contacts")}
              submitLabel="Remove from group"
              successLabel="Contacts removed from group"
              acceptCsv={false}
            />
          </TabsContent>
        ) : null}
      </Tabs>

      {/* Edit group dialog */}
      <FormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Edit contact group</DialogTitle>
          <DialogDescription>{group.name}</DialogDescription>
        </DialogHeader>
        <ContactGroupForm
          key={`edit-${group.id}`}
          mode="edit"
          initialValues={{
            name: group.name,
            contact_group_id: group.contact_group_id,
            description: group.description ?? "",
            color: group.color ?? "",
          }}
          onSubmit={handleEdit}
          onCancel={() => setEditOpen(false)}
          isSubmitting={updateApi.isLoading}
        />
      </FormDialog>

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
              {confirming === "archive"
                ? "Archive this contact group?"
                : "Restore this contact group?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming === "archive"
                ? "Archived groups are hidden but contact memberships are preserved."
                : "Restoring a group moves it back into the active list."}
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
              {confirming === "archive" ? "Archive" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk remove confirm */}
      <AlertDialog open={bulkRemoveConfirm} onOpenChange={setBulkRemoveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {selectedRows.size} contact
              {selectedRows.size === 1 ? "" : "s"} from this group?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The contacts remain in your registry; only their membership in
              this group is removed.
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
              className={cn(
                "bg-destructive text-destructive-foreground hover:bg-destructive/90",
              )}
            >
              Remove from group
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
