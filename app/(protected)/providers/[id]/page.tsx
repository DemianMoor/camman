"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  ArchiveRestore,
  Archive as ArchiveIcon,
  ArrowLeft,
  Check,
  Copy,
  MoreHorizontal,
  Pencil,
  Plus,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/data-table";
import { LiveSendingBanner } from "@/components/sends/live-sending-banner";
import {
  PhoneForm,
  type PhoneFormValues,
} from "@/components/providers/phone-form";
import { ProviderCredentialsSection } from "@/components/providers/provider-credentials-section";
import {
  ProviderForm,
  type ProviderFormValues,
} from "@/components/providers/provider-form";
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
import { Card, CardContent } from "@/components/ui/card";
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
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { formatPhoneInternational } from "@/lib/phone-validation";
import {
  NUMBER_TYPE_LABELS,
  type NumberType,
} from "@/lib/validators/provider-phones";
import { cn } from "@/lib/utils";

type Provider = {
  id: number;
  sms_provider_id: string;
  name: string;
  short_link_supported: boolean;
  short_link_example: string | null;
  supports_api_send: boolean;
  send_window_weekday_start: number | null;
  send_window_weekday_end: number | null;
  send_window_weekend_start: number | null;
  send_window_weekend_end: number | null;
  max_sends_per_run: number | null;
  max_sends_per_minute: number | null;
  max_sends_per_24h: number | null;
  send_paused: boolean;
  send_paused_reason: string | null;
  send_paused_at: string | null;
  avatar_url: string | null;
  color: string | null;
  status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
  org_id: string;
};

type PhoneStatus = "active" | "suspended" | "blocked" | "archived";

type Phone = {
  id: number;
  org_id: string;
  provider_id: number;
  brand_id: number | null;
  phone_number: string;
  country_code: string | null;
  dial_code: string | null;
  local_number: string | null;
  cost_per_sms: string;
  number_type: NumberType;
  status: PhoneStatus;
  archived_at: string | null;
  created_at: string;
  brand: {
    id: number;
    name: string;
    color: string | null;
    avatar_url: string | null;
  } | null;
};

type PhonesListResponse = { data: Phone[] };

type PhonesFilters = {
  search: string;
  statuses: PhoneStatus[]; // multi-select
  sortBy: string;
  sortDir: "asc" | "desc";
};

const DEFAULT_PHONE_FILTERS: PhonesFilters = {
  search: "",
  statuses: ["active", "suspended", "blocked"],
  sortBy: "created_at",
  sortDir: "desc",
};

const ALL_PHONE_STATUSES: PhoneStatus[] = [
  "active",
  "suspended",
  "blocked",
  "archived",
];

const PHONE_STATUS_OPTIONS: StatusOption<"active" | "suspended" | "blocked">[] = [
  { value: "active", label: "Active", color: "green" },
  { value: "suspended", label: "Suspended", color: "amber" },
  { value: "blocked", label: "Blocked", color: "red" },
];

const SEARCH_DEBOUNCE_MS = 300;

function PhoneNumberCell({ phone }: { phone: Phone }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(phone.phone_number);
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
      <span>
        {phone.number_type === "short_code"
          ? phone.phone_number
          : formatPhoneInternational(phone.phone_number)}
      </span>
      {copied ? (
        <Check className="size-3 text-emerald-600" aria-hidden />
      ) : (
        <Copy className="size-3 opacity-40" aria-hidden />
      )}
    </button>
  );
}

function BrandCell({ brand }: { brand: Phone["brand"] }) {
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

function StatusPill({ status }: { status: "active" | "archived" }) {
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

export default function ProviderDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const providerId = Number(params.id);
  const { auth, can } = useAuth();

  const providerApi = useApiCall<Provider>();
  const updateProviderApi = useApiCall<Provider>();
  const archiveProviderApi = useApiCall<Provider>();
  const restoreProviderApi = useApiCall<Provider>();
  const circuitApi = useApiCall<{ ok: boolean; send_paused: boolean }>();

  const phonesApi = useApiCall<PhonesListResponse>();
  const createPhoneApi = useApiCall<Phone>();
  const updatePhoneApi = useApiCall<Phone>();
  const statusPhoneApi = useApiCall<Phone>();
  const archivePhoneApi = useApiCall<Phone>();
  const restorePhoneApi = useApiCall<Phone>();

  const [provider, setProvider] = useState<Provider | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refetchProvider = useCallback(
    () => setRefreshTick((n) => n + 1),
    [],
  );

  useEffect(() => {
    if (!Number.isInteger(providerId) || providerId <= 0) return;
    let cancelled = false;
    setProviderError(null);
    (async () => {
      const result = await providerApi.execute(`/api/providers/${providerId}`);
      if (cancelled) return;
      if (result.ok) setProvider(result.data);
      else setProviderError(result.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [providerId, refreshTick, providerApi.execute]);

  // Phones state
  const [filters, updateFilters, resetFilters] =
    usePersistedFilters<PhonesFilters>(
      `provider-phones.${providerId}.filters`,
      DEFAULT_PHONE_FILTERS,
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

  const [phones, setPhones] = useState<Phone[]>([]);
  const [phonesError, setPhonesError] = useState<string | null>(null);
  const [phonesTick, setPhonesTick] = useState(0);
  const refetchPhones = useCallback(() => setPhonesTick((n) => n + 1), []);

  useEffect(() => {
    if (!Number.isInteger(providerId) || providerId <= 0) return;
    let cancelled = false;
    setPhonesError(null);

    const sp = new URLSearchParams({
      status: filters.statuses.join(","),
      sortBy: filters.sortBy,
      sortDir: filters.sortDir,
    });
    if (filters.search) sp.set("search", filters.search);

    (async () => {
      const result = await phonesApi.execute(
        `/api/providers/${providerId}/phones?${sp.toString()}`,
      );
      if (cancelled) return;
      if (result.ok) setPhones(result.data.data);
      else setPhonesError(result.error);
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
    phonesTick,
    phonesApi.execute,
  ]);

  // Dialog state
  const [editProviderOpen, setEditProviderOpen] = useState(false);
  const [addPhoneOpen, setAddPhoneOpen] = useState(false);
  const [editingPhone, setEditingPhone] = useState<Phone | null>(null);
  const [confirmingProvider, setConfirmingProvider] = useState<
    "archive" | "restore" | null
  >(null);
  const [confirmingResume, setConfirmingResume] = useState(false);
  const [confirmingPhone, setConfirmingPhone] = useState<
    | { kind: "archive"; phone: Phone }
    | { kind: "restore"; phone: Phone }
    | null
  >(null);

  const canUpdateProvider = can("providers.update");
  const canArchiveProvider = can("providers.archive");
  const canRestoreProvider = can("providers.restore");
  const canCreatePhone = can("provider_phones.create");
  const canUpdatePhone = can("provider_phones.update");
  const canArchivePhone = can("provider_phones.archive");
  const canRestorePhone = can("provider_phones.restore");
  const canViewCredentials = can("provider_credentials.view");
  const canManageCredentials = can("provider_credentials.manage");

  async function handleProviderEdit(values: ProviderFormValues) {
    if (!provider) return;
    const { sms_provider_id: _omit, ...patch } = values;
    const result = await updateProviderApi.execute(
      `/api/providers/${provider.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't save provider");
      return;
    }
    toast.success("Provider saved");
    setEditProviderOpen(false);
    refetchProvider();
  }

  async function handleProviderConfirm() {
    if (!provider || !confirmingProvider) return;
    const isArchive = confirmingProvider === "archive";
    const api = isArchive ? archiveProviderApi : restoreProviderApi;
    const result = await api.execute(
      `/api/providers/${provider.id}/${isArchive ? "archive" : "restore"}`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    toast.success(isArchive ? "Provider archived" : "Provider restored");
    setConfirmingProvider(null);
    refetchProvider();
  }

  async function handleCircuit(action: "pause" | "resume") {
    if (!provider) return;
    const result = await circuitApi.execute(
      `/api/providers/${provider.id}/send-circuit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't update sending circuit");
      return;
    }
    toast.success(action === "pause" ? "Sending paused" : "Sending resumed");
    setConfirmingResume(false);
    refetchProvider();
  }

  async function handleAddPhone(values: PhoneFormValues) {
    if (!provider) return;
    const result = await createPhoneApi.execute(
      `/api/providers/${provider.id}/phones`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't add phone");
      return;
    }
    toast.success("Phone added");
    setAddPhoneOpen(false);
    refetchPhones();
  }

  async function handleEditPhone(values: PhoneFormValues) {
    if (!editingPhone || !provider) return;
    const patch = {
      cost_per_sms: values.cost_per_sms,
      brand_id: values.brand_id,
    };
    const result = await updatePhoneApi.execute(
      `/api/providers/${provider.id}/phones/${editingPhone.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't save phone");
      return;
    }
    toast.success("Phone saved");
    setEditingPhone(null);
    refetchPhones();
  }

  async function handlePhoneStatusChange(
    phone: Phone,
    next: "active" | "suspended" | "blocked",
  ) {
    if (!provider) return;
    const result = await statusPhoneApi.execute(
      `/api/providers/${provider.id}/phones/${phone.id}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't update phone status");
      return;
    }
    toast.success(`Phone marked ${next}`);
    refetchPhones();
  }

  async function handlePhoneConfirm() {
    if (!confirmingPhone || !provider) return;
    const isArchive = confirmingPhone.kind === "archive";
    const api = isArchive ? archivePhoneApi : restorePhoneApi;
    const result = await api.execute(
      `/api/providers/${provider.id}/phones/${confirmingPhone.phone.id}/${isArchive ? "archive" : "restore"}`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    toast.success(isArchive ? "Phone archived" : "Phone restored");
    setConfirmingPhone(null);
    refetchPhones();
  }

  const columns = useMemo<ColumnDef<Phone>[]>(
    () => [
      {
        id: "phone_number",
        header: "Phone Number",
        cell: ({ row }) => <PhoneNumberCell phone={row.original} />,
        enableSorting: true,
      },
      {
        id: "number_type",
        header: "Type",
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant="secondary" className="font-normal">
            {NUMBER_TYPE_LABELS[row.original.number_type]}
          </Badge>
        ),
      },
      {
        id: "country",
        header: "Country",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.country_code ?? "—"}
          </span>
        ),
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
          const phone = row.original;
          const isArchived = phone.status === "archived";
          if (isArchived) {
            return (
              <Badge className="border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                Archived
              </Badge>
            );
          }
          return (
            <StatusDropdown<"active" | "suspended" | "blocked">
              current={phone.status as "active" | "suspended" | "blocked"}
              options={PHONE_STATUS_OPTIONS}
              onChange={(next) => handlePhoneStatusChange(phone, next)}
              isUpdating={
                statusPhoneApi.isLoading
              }
              isTerminal={!canUpdatePhone}
            />
          );
        },
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const phone = row.original;
          const showEdit = canUpdatePhone;
          const showArchive =
            phone.status !== "archived" && canArchivePhone;
          const showRestore =
            phone.status === "archived" && canRestorePhone;
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
                    <DropdownMenuItem onSelect={() => setEditingPhone(phone)}>
                      <Pencil className="size-4" aria-hidden /> Edit
                    </DropdownMenuItem>
                  ) : null}
                  {showArchive ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirmingPhone({ kind: "archive", phone })
                      }
                    >
                      <ArchiveIcon className="size-4" aria-hidden /> Archive
                    </DropdownMenuItem>
                  ) : null}
                  {showRestore ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setConfirmingPhone({ kind: "restore", phone })
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
    [canUpdatePhone, canArchivePhone, canRestorePhone, statusPhoneApi.isLoading],
  );

  if (!auth) return null;

  if (providerError) {
    return (
      <div className="space-y-4">
        <Link
          href="/providers"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3" aria-hidden /> All providers
        </Link>
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">{providerError}</p>
        </div>
      </div>
    );
  }

  if (!provider) {
    return (
      <div className="space-y-4">
        <Link
          href="/providers"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3" aria-hidden /> All providers
        </Link>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const providerInitial = provider.name.charAt(0).toUpperCase() || "?";

  function toggleStatusFilter(s: PhoneStatus) {
    const set = new Set(filters.statuses);
    if (set.has(s)) set.delete(s);
    else set.add(s);
    const next = ALL_PHONE_STATUSES.filter((x) => set.has(x));
    updateFilters({ statuses: next.length > 0 ? next : ["active"] });
  }

  return (
    <div className="space-y-6">
      <Link
        href="/providers"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3" aria-hidden /> All providers
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-base font-medium text-white"
            style={{ backgroundColor: provider.color ?? "#64748B" }}
          >
            {providerInitial}
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {provider.name}
            </h1>
            <div className="mt-1 flex items-center gap-2 text-sm">
              <span className="font-mono text-xs text-muted-foreground">
                {provider.sms_provider_id}
              </span>
              <StatusPill status={provider.status} />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canUpdateProvider ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditProviderOpen(true)}
            >
              <Pencil className="size-4" aria-hidden /> Edit
            </Button>
          ) : null}
          {provider.status === "active" && canArchiveProvider ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmingProvider("archive")}
            >
              <ArchiveIcon className="size-4" aria-hidden /> Archive
            </Button>
          ) : null}
          {provider.status === "archived" && canRestoreProvider ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmingProvider("restore")}
            >
              <ArchiveRestore className="size-4" aria-hidden /> Restore
            </Button>
          ) : null}
        </div>
      </header>

      {/* Global live-sending master state (Bug 2). The provider badges below are
          CAPABILITIES + breakers, NOT the global on/off — surface the real
          send-gate here so "Active" capability badges can't be misread as "live". */}
      <LiveSendingBanner variant="strip" />

      <Card>
        <CardContent className="grid gap-3 pt-6 text-sm md:grid-cols-3">
          <div className="md:col-span-3 -mb-1 text-xs text-muted-foreground">
            Provider capabilities &amp; status (not the global send switch above):
          </div>
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">
              Short links supported
            </span>
            <span className="font-medium">
              {provider.short_link_supported ? "Yes" : "No"}
            </span>
          </div>
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">
              Short link example
            </span>
            <span className="font-mono text-xs">
              {provider.short_link_example ?? "—"}
            </span>
          </div>
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">API sending</span>
            <span className="font-medium">
              {provider.supports_api_send ? "Enabled" : "Off"}
            </span>
          </div>
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">Created</span>
            <span>
              {format(new Date(provider.created_at), "MMM d, yyyy")}
            </span>
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium">Phone Numbers</h2>
          {canCreatePhone ? (
            <Button onClick={() => setAddPhoneOpen(true)}>
              <Plus className="size-4" aria-hidden /> Add phone
            </Button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search phone number…"
            className="h-9 w-full max-w-sm"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {ALL_PHONE_STATUSES.map((s) => {
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
          {(filters.search !== DEFAULT_PHONE_FILTERS.search ||
            filters.statuses.join(",") !==
              DEFAULT_PHONE_FILTERS.statuses.join(",")) ? (
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

        {phonesError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <p className="text-destructive">{phonesError}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={refetchPhones}
            >
              Retry
            </Button>
          </div>
        ) : !phonesApi.isLoading && phones.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed py-12 text-center">
            <p className="text-sm font-medium">No phones yet</p>
            <p className="text-sm text-muted-foreground">
              Add the first phone number for this provider.
            </p>
            {canCreatePhone ? (
              <Button onClick={() => setAddPhoneOpen(true)}>
                <Plus className="size-4" aria-hidden /> Add phone
              </Button>
            ) : null}
          </div>
        ) : (
          <DataTable<Phone>
            data={phones}
            columns={columns}
            isLoading={phonesApi.isLoading}
            pageIndex={0}
            pageSize={phones.length || 20}
            totalCount={phones.length}
            onPageChange={() => {}}
            onPageSizeChange={() => {}}
            sortBy={filters.sortBy || null}
            sortDir={filters.sortDir}
            onSortChange={(by, dir) =>
              updateFilters({ sortBy: by ?? "created_at", sortDir: dir })
            }
          />
        )}
      </section>

      {/* Accounts (API keys) — manager+ (provider_credentials.view) can see the
          masked list; admin+ (provider_credentials.manage) gets the mutate
          buttons, matching the server-side gates on the credentials routes. */}
      {canViewCredentials ? (
        <ProviderCredentialsSection
          providerId={provider.id}
          providerKey={provider.sms_provider_id}
          canManage={canManageCredentials}
        />
      ) : null}

      {/* Sending circuit breaker — only meaningful for API-send providers. */}
      {provider.supports_api_send ? (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Sending circuit</h2>
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-6">
              <div className="grid gap-1 text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Status</span>
                  {provider.send_paused ? (
                    <Badge className="border-red-200 bg-red-100 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                      Paused
                    </Badge>
                  ) : (
                    <Badge className="border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
                      Active
                    </Badge>
                  )}
                </div>
                {provider.send_paused ? (
                  <p className="text-xs text-muted-foreground">
                    {provider.send_paused_reason ?? "Paused"}
                    {provider.send_paused_at
                      ? ` · ${format(new Date(provider.send_paused_at), "MMM d, yyyy HH:mm")}`
                      : ""}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Automated sends run normally. Pause to hard-stop all sending
                    for this provider.
                  </p>
                )}
              </div>
              {canUpdateProvider ? (
                provider.send_paused ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmingResume(true)}
                    disabled={circuitApi.isLoading}
                  >
                    Resume sending
                  </Button>
                ) : (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => void handleCircuit("pause")}
                    disabled={circuitApi.isLoading}
                  >
                    Pause sending
                  </Button>
                )
              ) : null}
            </CardContent>
          </Card>
        </section>
      ) : null}

      {/* Edit Provider dialog */}
      <FormDialog
        open={editProviderOpen}
        onOpenChange={setEditProviderOpen}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Edit provider</DialogTitle>
          <DialogDescription>{provider.name}</DialogDescription>
        </DialogHeader>
        <ProviderForm
          key={`edit-${provider.id}`}
          mode="edit"
          initialValues={{
            name: provider.name,
            sms_provider_id: provider.sms_provider_id,
            short_link_supported: provider.short_link_supported,
            short_link_example: provider.short_link_example ?? "",
            supports_api_send: provider.supports_api_send,
            send_window_weekday_start: provider.send_window_weekday_start,
            send_window_weekday_end: provider.send_window_weekday_end,
            send_window_weekend_start: provider.send_window_weekend_start,
            send_window_weekend_end: provider.send_window_weekend_end,
            max_sends_per_run: provider.max_sends_per_run,
            max_sends_per_minute: provider.max_sends_per_minute,
            max_sends_per_24h: provider.max_sends_per_24h,
            avatar_url: provider.avatar_url ?? "",
            color: provider.color ?? "",
          }}
          onSubmit={handleProviderEdit}
          onCancel={() => setEditProviderOpen(false)}
          isSubmitting={updateProviderApi.isLoading}
        />
      </FormDialog>

      {/* Add phone dialog */}
      <FormDialog
        open={addPhoneOpen}
        onOpenChange={setAddPhoneOpen}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Add phone</DialogTitle>
          <DialogDescription>For {provider.name}</DialogDescription>
        </DialogHeader>
        <PhoneForm
          key="add"
          mode="create"
          onSubmit={handleAddPhone}
          onCancel={() => setAddPhoneOpen(false)}
          isSubmitting={createPhoneApi.isLoading}
        />
      </FormDialog>

      {/* Edit phone dialog */}
      <FormDialog
        open={editingPhone !== null}
        onOpenChange={(open) => {
          if (!open) setEditingPhone(null);
        }}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Edit phone</DialogTitle>
          <DialogDescription>
            {editingPhone
              ? formatPhoneInternational(editingPhone.phone_number)
              : ""}
          </DialogDescription>
        </DialogHeader>
        {editingPhone ? (
          <PhoneForm
            key={`edit-phone-${editingPhone.id}`}
            mode="edit"
            existingPhoneNumber={editingPhone.phone_number}
            initialValues={{
              phone_number: editingPhone.phone_number,
              number_type: editingPhone.number_type,
              cost_per_sms: Number(editingPhone.cost_per_sms),
              brand_id: editingPhone.brand_id,
            }}
            onSubmit={handleEditPhone}
            onCancel={() => setEditingPhone(null)}
            isSubmitting={updatePhoneApi.isLoading}
          />
        ) : null}
      </FormDialog>

      {/* Provider archive/restore confirm */}
      <AlertDialog
        open={confirmingProvider !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingProvider(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmingProvider === "archive"
                ? "Archive this provider?"
                : "Restore this provider?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmingProvider === "archive"
                ? "Archived providers are hidden from the active list but their phones are preserved."
                : "Restoring a provider moves it back into the active list."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={
                archiveProviderApi.isLoading || restoreProviderApi.isLoading
              }
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleProviderConfirm();
              }}
              disabled={
                archiveProviderApi.isLoading || restoreProviderApi.isLoading
              }
            >
              {confirmingProvider === "archive" ? "Archive" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Resume sending confirm — un-pausing after a trip is consequential. */}
      <AlertDialog
        open={confirmingResume}
        onOpenChange={(open) => {
          if (!open) setConfirmingResume(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Resume sending for this provider?</AlertDialogTitle>
            <AlertDialogDescription>
              {provider.send_paused_reason
                ? `Paused: ${provider.send_paused_reason}. `
                : ""}
              Resuming clears the circuit breaker and lets automated sends run
              again. This is recorded against your account. Confirm the
              underlying issue is resolved first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={circuitApi.isLoading}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleCircuit("resume");
              }}
              disabled={circuitApi.isLoading}
            >
              Resume sending
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Phone archive/restore confirm */}
      <AlertDialog
        open={confirmingPhone !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingPhone(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmingPhone?.kind === "archive"
                ? "Archive this phone?"
                : "Restore this phone?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmingPhone?.kind === "archive"
                ? "Archived phones can be restored later. Restored phones come back as active."
                : "Restored phones come back as active regardless of their pre-archive status."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={
                archivePhoneApi.isLoading || restorePhoneApi.isLoading
              }
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handlePhoneConfirm();
              }}
              disabled={
                archivePhoneApi.isLoading || restorePhoneApi.isLoading
              }
            >
              {confirmingPhone?.kind === "archive" ? "Archive" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
