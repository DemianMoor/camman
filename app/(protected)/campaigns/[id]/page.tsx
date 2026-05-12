"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  ArchiveRestore,
  Archive as ArchiveIcon,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Send,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import {
  CampaignForm,
  type AudienceFilters,
  type CampaignFormValues,
} from "@/components/campaigns/campaign-form";
import { StageForm, type StageFormValues } from "@/components/campaigns/stage-form";
import {
  StageStatusChangeDialog,
  type StageTransition,
  transitionToStageStatus,
} from "@/components/campaigns/stage-status-change-dialog";
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
import { Card, CardContent } from "@/components/ui/card";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api/toast-error";
import {
  campaignLocalInputToUtcIso,
  formatCampaignDateTime,
  utcToCampaignLocalInput,
} from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { formatPhoneInternational } from "@/lib/phone-validation";
import { cn } from "@/lib/utils";

// =============== Types ===============

type Info = { id: number; name: string; color: string | null };
type Offer = Info & { sales_pages?: { label: string; url: string }[] };
type CampaignStatus = "draft" | "active" | "paused" | "completed" | "archived";
type StageStatus =
  | "draft"
  | "pending"
  | "sent"
  | "success"
  | "cancelled"
  | "failed"
  | "archived";
type ActiveStageStatus = Exclude<StageStatus, "archived">;

type CampaignDetail = {
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
  audience_filters: AudienceFilters;
  audience_snapshot_count: number;
  start_date: string | null;
  end_date: string | null;
  status: CampaignStatus;
  status_changed_at: string;
  archived_at: string | null;
  created_at: string;
  brand: Info | null;
  offer: Offer | null;
  routing_type: Info | null;
  traffic_type: Info | null;
  stage_count_total: number;
  stage_count_by_status: Record<string, number>;
};

type Stage = {
  id: number;
  campaign_id: number;
  stage_number: number;
  label: string | null;
  creative_id: number | null;
  sms_provider_id: number | null;
  provider_phone_id: number | null;
  sales_page_label: string | null;
  stop_text: string;
  include_clickers: boolean;
  exclude_clickers: boolean;
  include_no_status: boolean;
  scheduled_at: string | null;
  sent_at: string | null;
  status: StageStatus;
  sms_count: number;
  total_cost: string;
  delivered_count: number;
  opt_out_count: number;
  click_count: number;
  notes: string | null;
  archived_at: string | null;
  created_at: string;
  creative: { id: number; slug: string; text: string } | null;
  provider: Info | null;
  provider_phone: { id: number; phone_number: string } | null;
};

type StagesListResponse = { data: Stage[]; totalCount: number };

type Member = {
  id: string;
  email: string | null;
  display_name: string | null;
};

const CAMPAIGN_STATUS_COLOR: Record<CampaignStatus, string> = {
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

const STAGE_STATUS_COLOR: Record<StageStatus, string> = {
  draft:
    "border-slate-200 bg-slate-100 text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200",
  pending:
    "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  sent:
    "border-sky-200 bg-sky-100 text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200",
  success:
    "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  cancelled:
    "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300",
  failed:
    "border-red-200 bg-red-100 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
  archived:
    "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
};

const ALL_STAGE_STATUSES: StageStatus[] = [
  "draft",
  "pending",
  "sent",
  "success",
  "cancelled",
  "failed",
];

// Per-current-status legal transitions (mirrors the stage API state
// machine — UI just disables disallowed picks).
const STAGE_TRANSITION_MAP: Record<
  ActiveStageStatus,
  { label: string; t: StageTransition; icon: React.ReactNode }[]
> = {
  draft: [
    {
      label: "Mark pending",
      t: "to_pending",
      icon: <Send className="size-4" aria-hidden />,
    },
    {
      label: "Cancel",
      t: "to_cancelled",
      icon: <ArchiveIcon className="size-4" aria-hidden />,
    },
  ],
  pending: [
    {
      label: "Back to draft",
      t: "to_draft",
      icon: <Pencil className="size-4" aria-hidden />,
    },
    {
      label: "Mark sent",
      t: "to_sent",
      icon: <Send className="size-4" aria-hidden />,
    },
    {
      label: "Cancel",
      t: "to_cancelled",
      icon: <ArchiveIcon className="size-4" aria-hidden />,
    },
  ],
  sent: [
    {
      label: "Mark successful",
      t: "to_success",
      icon: <CheckCircle2 className="size-4" aria-hidden />,
    },
    {
      label: "Mark failed",
      t: "to_failed",
      icon: <ArchiveIcon className="size-4" aria-hidden />,
    },
  ],
  success: [],
  cancelled: [],
  failed: [],
};

type StagesFilters = {
  statuses: StageStatus[];
  showArchived: boolean;
};

const DEFAULT_STAGE_FILTERS: StagesFilters = {
  statuses: [],
  showArchived: false,
};

function buildCampaignPatchBody(values: CampaignFormValues): Record<string, unknown> {
  return {
    name: values.name.trim(),
    human_id: values.human_id.trim() ? values.human_id.trim() : "",
    notes: values.notes.trim() ? values.notes.trim() : "",
    brand_id: values.brand_id,
    offer_id: values.offer_id,
    routing_type_id: values.routing_type_id,
    traffic_type_id: values.traffic_type_id,
    assigned_to_user_id: values.assigned_to_user_id,
    audience_segment_ids: values.audience_segment_ids,
    audience_filters: values.audience_filters,
    start_date: values.start_date || undefined,
    end_date: values.end_date || undefined,
  };
}

function buildStageCreateBody(values: StageFormValues): Record<string, unknown> {
  return {
    label: values.label.trim() ? values.label.trim() : undefined,
    creative_id: values.creative_id,
    sms_provider_id: values.sms_provider_id,
    provider_phone_id: values.provider_phone_id,
    sales_page_label: values.sales_page_label || undefined,
    stop_text: values.stop_text,
    include_no_status: values.include_no_status,
    include_clickers: values.include_clickers,
    exclude_clickers: values.exclude_clickers,
    scheduled_at: values.scheduled_at
      ? campaignLocalInputToUtcIso(values.scheduled_at)
      : null,
    notes: values.notes.trim() ? values.notes.trim() : undefined,
  };
}

export default function CampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const campaignId = Number(params.id);
  const { auth, can } = useAuth();

  const campaignApi = useApiCall<CampaignDetail>();
  const stagesApi = useApiCall<StagesListResponse>();
  const membersApi = useApiCall<{ data: Member[] }>();
  const campaignUpdateApi = useApiCall<CampaignDetail>();
  const campaignStatusApi = useApiCall<CampaignDetail>();
  const campaignArchiveApi = useApiCall<CampaignDetail>();
  const campaignRestoreApi = useApiCall<CampaignDetail>();
  const stageCreateApi = useApiCall<Stage>();
  const stageUpdateApi = useApiCall<Stage>();
  const stageStatusApi = useApiCall<Stage>();
  const stageArchiveApi = useApiCall<Stage>();
  const stageRestoreApi = useApiCall<Stage>();

  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [campaignTick, setCampaignTick] = useState(0);
  const refetchCampaign = useCallback(
    () => setCampaignTick((n) => n + 1),
    [],
  );

  const [stages, setStages] = useState<Stage[]>([]);
  const [stagesError, setStagesError] = useState<string | null>(null);
  const [stagesTick, setStagesTick] = useState(0);
  const refetchStages = useCallback(() => setStagesTick((n) => n + 1), []);

  const [members, setMembers] = useState<Member[]>([]);

  // Per-campaign persisted filters for the stages table.
  const [stageFilters, updateStageFilters, resetStageFilters] =
    usePersistedFilters<StagesFilters>(
      `campaign-${campaignId}.stages.filters`,
      DEFAULT_STAGE_FILTERS,
    );

  useEffect(() => {
    if (!Number.isInteger(campaignId) || campaignId <= 0) return;
    let cancelled = false;
    (async () => {
      const r = await campaignApi.execute(`/api/campaigns/${campaignId}`);
      if (cancelled) return;
      if (r.ok) setCampaign(r.data);
      else setCampaignError(r.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId, campaignTick, campaignApi.execute]);

  useEffect(() => {
    if (!Number.isInteger(campaignId) || campaignId <= 0) return;
    let cancelled = false;
    const sp = new URLSearchParams();
    if (stageFilters.statuses.length > 0)
      sp.set("status", stageFilters.statuses.join(","));
    if (stageFilters.showArchived) sp.set("showArchived", "true");
    const qs = sp.toString();
    (async () => {
      const r = await stagesApi.execute(
        `/api/campaigns/${campaignId}/stages${qs ? `?${qs}` : ""}`,
      );
      if (cancelled) return;
      if (r.ok) setStages(r.data.data);
      else setStagesError(r.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    campaignId,
    stageFilters.statuses,
    stageFilters.showArchived,
    stagesTick,
    stagesApi.execute,
  ]);

  useEffect(() => {
    (async () => {
      const r = await membersApi.execute("/api/members");
      if (r.ok) setMembers(r.data.data);
    })();
  }, [membersApi.execute]);

  // ============ Dialog state ============
  const [editCampaignOpen, setEditCampaignOpen] = useState(false);
  const [campaignTransition, setCampaignTransition] =
    useState<CampaignTransition | null>(null);
  const [campaignArchiveConfirm, setCampaignArchiveConfirm] = useState<
    null | "archive" | "restore"
  >(null);

  const [addStageOpen, setAddStageOpen] = useState(false);
  const [editingStage, setEditingStage] = useState<Stage | null>(null);
  const [stageTransitionTarget, setStageTransitionTarget] = useState<{
    stage: Stage;
    transition: StageTransition;
  } | null>(null);
  const [stageArchiveConfirm, setStageArchiveConfirm] = useState<{
    kind: "archive" | "restore";
    stage: Stage;
  } | null>(null);

  const canUpdateCampaign = can("campaigns.update");
  const canActivate = can("campaigns.activate");
  const canPause = can("campaigns.pause");
  const canComplete = can("campaigns.complete");
  const canArchiveCampaign = can("campaigns.archive");
  const canRestoreCampaign = can("campaigns.restore");
  const canCreateStage = can("stages.create");
  const canUpdateStage = can("stages.update");
  const canSendStage = can("stages.send");
  const canArchiveStage = can("stages.archive");
  const canRestoreStage = can("stages.restore");

  // ============ Handlers ============

  async function handleCampaignEdit(values: CampaignFormValues) {
    if (!campaign) return;
    const body = buildCampaignPatchBody(values);
    if (campaign.status !== "draft") {
      delete body.audience_segment_ids;
      delete body.audience_filters;
    }
    const result = await campaignUpdateApi.execute(
      `/api/campaigns/${campaign.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't save campaign");
      return;
    }
    toast.success("Campaign saved");
    setEditCampaignOpen(false);
    refetchCampaign();
  }

  async function handleCampaignTransition() {
    if (!campaign || !campaignTransition) return;
    const next = transitionToStatus(campaignTransition);
    const result = await campaignStatusApi.execute(
      `/api/campaigns/${campaign.id}/status`,
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
    setCampaignTransition(null);
    refetchCampaign();
  }

  async function handleCampaignArchiveRestore() {
    if (!campaign || !campaignArchiveConfirm) return;
    const isArchive = campaignArchiveConfirm === "archive";
    const api = isArchive ? campaignArchiveApi : campaignRestoreApi;
    const result = await api.execute(
      `/api/campaigns/${campaign.id}/${isArchive ? "archive" : "restore"}`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    toast.success(isArchive ? "Campaign archived" : "Campaign restored");
    setCampaignArchiveConfirm(null);
    refetchCampaign();
  }

  async function handleStageCreate(values: StageFormValues) {
    const result = await stageCreateApi.execute(
      `/api/campaigns/${campaignId}/stages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildStageCreateBody(values)),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't create stage");
      return;
    }
    toast.success(`Stage ${result.data.stage_number} created`);
    setAddStageOpen(false);
    refetchStages();
    refetchCampaign();
  }

  async function handleStageEdit(values: StageFormValues) {
    if (!editingStage) return;
    const result = await stageUpdateApi.execute(
      `/api/campaigns/${campaignId}/stages/${editingStage.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildStageCreateBody(values)),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't save stage");
      return;
    }
    toast.success("Stage saved");
    setEditingStage(null);
    refetchStages();
  }

  async function handleStageTransition() {
    if (!stageTransitionTarget) return;
    const next = transitionToStageStatus(stageTransitionTarget.transition);
    const result = await stageStatusApi.execute(
      `/api/campaigns/${campaignId}/stages/${stageTransitionTarget.stage.id}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't change stage status");
      return;
    }
    toast.success(`Stage ${next}`);
    setStageTransitionTarget(null);
    refetchStages();
    refetchCampaign();
  }

  async function handleStageArchiveRestore() {
    if (!stageArchiveConfirm) return;
    const isArchive = stageArchiveConfirm.kind === "archive";
    const api = isArchive ? stageArchiveApi : stageRestoreApi;
    const result = await api.execute(
      `/api/campaigns/${campaignId}/stages/${stageArchiveConfirm.stage.id}/${isArchive ? "archive" : "restore"}`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result);
      return;
    }
    toast.success(isArchive ? "Stage archived" : "Stage restored");
    setStageArchiveConfirm(null);
    refetchStages();
    refetchCampaign();
  }

  // ============ Stage columns ============

  function activityFilterLabel(s: Stage): string {
    if (s.include_clickers) return "Clickers only";
    if (s.exclude_clickers) return "Excluding clickers";
    return "All";
  }

  const stageColumns = useMemo<ColumnDef<Stage>[]>(
    () => [
      {
        id: "stage_number",
        header: "#",
        enableSorting: true,
        cell: ({ row }) => (
          <Badge variant="outline" className="font-mono text-[10px]">
            {row.original.stage_number}
          </Badge>
        ),
      },
      {
        id: "label",
        header: "Label",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.label ? (
            <span className="text-sm">{row.original.label}</span>
          ) : (
            <span className="text-sm text-muted-foreground">(no label)</span>
          ),
      },
      {
        id: "creative",
        header: "Creative",
        enableSorting: false,
        cell: ({ row }) => {
          const c = row.original.creative;
          if (!c) return <span className="text-muted-foreground">—</span>;
          return (
            <div className="min-w-0" title={c.text}>
              <div className="font-mono text-xs text-muted-foreground">
                {c.slug}
              </div>
              <div className="truncate text-sm">
                {c.text.slice(0, 50)}
                {c.text.length > 50 ? "…" : ""}
              </div>
            </div>
          );
        },
      },
      {
        id: "provider",
        header: "Provider",
        enableSorting: false,
        cell: ({ row }) => {
          const p = row.original.provider;
          const phone = row.original.provider_phone;
          if (!p && !phone)
            return <span className="text-muted-foreground">—</span>;
          return (
            <div className="min-w-0">
              {p ? (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: p.color ?? "#64748B" }}
                  />
                  <span className="text-sm">{p.name}</span>
                </span>
              ) : null}
              {phone ? (
                <div className="font-mono text-xs text-muted-foreground">
                  {formatPhoneInternational(phone.phone_number)}
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "activity",
        header: "Activity",
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant="secondary" className="text-[10px]">
            {activityFilterLabel(row.original)}
          </Badge>
        ),
      },
      {
        id: "scheduled",
        header: "Scheduled",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.scheduled_at ? (
            <span className="text-sm text-muted-foreground">
              {formatCampaignDateTime(row.original.scheduled_at)}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "sent_at",
        header: "Sent",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.sent_at ? (
            <span
              className="text-sm text-muted-foreground"
              title={formatDistanceToNow(new Date(row.original.sent_at), {
                addSuffix: true,
              })}
            >
              {formatCampaignDateTime(row.original.sent_at)}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "status",
        header: "Status",
        enableSorting: false,
        cell: ({ row }) => (
          <Badge
            className={cn("capitalize", STAGE_STATUS_COLOR[row.original.status])}
          >
            {row.original.status}
          </Badge>
        ),
      },
      {
        id: "sms_count",
        header: "SMS",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.sms_count > 0 ? (
            <span className="font-mono text-sm tabular-nums">
              {row.original.sms_count.toLocaleString()}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "cost",
        header: "Cost",
        enableSorting: false,
        cell: ({ row }) => {
          const v = Number(row.original.total_cost);
          if (v === 0) return <span className="text-muted-foreground">—</span>;
          return (
            <span className="font-mono text-sm tabular-nums">
              ${v.toFixed(2)}
            </span>
          );
        },
      },
      {
        id: "results",
        header: "Results",
        enableSorting: false,
        cell: ({ row }) => {
          const { opt_out_count: oo, click_count: cl } = row.original;
          if (oo === 0 && cl === 0)
            return <span className="text-muted-foreground">—</span>;
          return (
            <span className="font-mono text-xs tabular-nums">
              OO: {oo} · CL: {cl}
            </span>
          );
        },
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const s = row.original;
          const showEdit = canUpdateStage && s.status !== "archived";
          const showArchive = s.status !== "archived" && canArchiveStage;
          const showRestore = s.status === "archived" && canRestoreStage;
          const transitions =
            s.status === "archived"
              ? []
              : STAGE_TRANSITION_MAP[s.status as ActiveStageStatus] ?? [];
          const canTransition = canSendStage && transitions.length > 0;
          if (!showEdit && !showArchive && !showRestore && !canTransition)
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
                    <DropdownMenuItem onSelect={() => setEditingStage(s)}>
                      <Pencil className="size-4" aria-hidden /> Edit
                    </DropdownMenuItem>
                  ) : null}
                  {canTransition ? (
                    <>
                      {showEdit ? <DropdownMenuSeparator /> : null}
                      {transitions.map((tr) => (
                        <DropdownMenuItem
                          key={tr.t}
                          onSelect={() =>
                            setStageTransitionTarget({
                              stage: s,
                              transition: tr.t,
                            })
                          }
                        >
                          {tr.icon} {tr.label}
                        </DropdownMenuItem>
                      ))}
                    </>
                  ) : null}
                  {(showArchive || showRestore) ? (
                    <DropdownMenuSeparator />
                  ) : null}
                  {showArchive ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setStageArchiveConfirm({ kind: "archive", stage: s })
                      }
                    >
                      <ArchiveIcon className="size-4" aria-hidden /> Archive
                    </DropdownMenuItem>
                  ) : null}
                  {showRestore ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        setStageArchiveConfirm({ kind: "restore", stage: s })
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
    [canUpdateStage, canArchiveStage, canRestoreStage, canSendStage],
  );

  if (!auth) return null;

  if (campaignError) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">{campaignError}</p>
        </div>
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="space-y-4">
        <BackLink />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  // ============ Campaign-level transitions menu ============
  const possibleCampaignTransitions: {
    label: string;
    t: CampaignTransition;
    icon: React.ReactNode;
  }[] = [];
  if (campaign.status === "draft" && canActivate)
    possibleCampaignTransitions.push({
      label: "Activate",
      t: "activate",
      icon: <Send className="size-4" aria-hidden />,
    });
  if (campaign.status === "active" && canPause)
    possibleCampaignTransitions.push({
      label: "Pause",
      t: "pause",
      icon: <Pause className="size-4" aria-hidden />,
    });
  if (campaign.status === "active" && canComplete)
    possibleCampaignTransitions.push({
      label: "Mark complete",
      t: "complete",
      icon: <CheckCircle2 className="size-4" aria-hidden />,
    });
  if (campaign.status === "paused" && canPause)
    possibleCampaignTransitions.push({
      label: "Resume",
      t: "resume",
      icon: <Play className="size-4" aria-hidden />,
    });
  if (campaign.status === "paused" && canComplete)
    possibleCampaignTransitions.push({
      label: "Mark complete",
      t: "complete",
      icon: <CheckCircle2 className="size-4" aria-hidden />,
    });

  const memberLabel = (userId: string | null) => {
    if (!userId) return null;
    const m = members.find((mm) => mm.id === userId);
    return m?.display_name ?? m?.email ?? userId;
  };

  // Stage roll-up subtitle
  const roleUpParts: string[] = [];
  for (const status of ALL_STAGE_STATUSES) {
    const n = campaign.stage_count_by_status?.[status] ?? 0;
    if (n > 0) roleUpParts.push(`${n} ${status}`);
  }
  const rollupSubtitle =
    campaign.stage_count_total === 0
      ? "No stages yet"
      : `${campaign.stage_count_total} stage${campaign.stage_count_total === 1 ? "" : "s"} — ${roleUpParts.join(", ")}`;

  // Edit-dialog initial values
  const editValues: CampaignFormValues = {
    name: campaign.name,
    human_id: campaign.human_id ?? "",
    notes: campaign.notes ?? "",
    brand_id: campaign.brand_id,
    offer_id: campaign.offer_id,
    routing_type_id: campaign.routing_type_id,
    traffic_type_id: campaign.traffic_type_id,
    assigned_to_user_id: campaign.assigned_to_user_id,
    audience_segment_ids: campaign.audience_segment_ids ?? [],
    audience_filters: {
      include_no_status: campaign.audience_filters?.include_no_status ?? true,
      include_opt_in: campaign.audience_filters?.include_opt_in ?? false,
      include_clickers: campaign.audience_filters?.include_clickers ?? false,
      include_not_clicked:
        campaign.audience_filters?.include_not_clicked ?? true,
    },
    start_date: campaign.start_date ?? "",
    end_date: campaign.end_date ?? "",
  };

  // Edit-stage initial values
  const editStageValues: StageFormValues | null = editingStage
    ? {
        label: editingStage.label ?? "",
        creative_id: editingStage.creative_id,
        sms_provider_id: editingStage.sms_provider_id,
        provider_phone_id: editingStage.provider_phone_id,
        sales_page_label: editingStage.sales_page_label ?? "",
        stop_text: editingStage.stop_text,
        include_no_status: editingStage.include_no_status,
        include_clickers: editingStage.include_clickers,
        exclude_clickers: editingStage.exclude_clickers,
        scheduled_at: utcToCampaignLocalInput(editingStage.scheduled_at),
        notes: editingStage.notes ?? "",
      }
    : null;

  return (
    <div className="space-y-6">
      <BackLink />

      {/* ============ Header ============ */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {campaign.name}
            </h1>
            <Badge
              className={cn(
                "capitalize",
                CAMPAIGN_STATUS_COLOR[campaign.status],
              )}
            >
              {campaign.status}
            </Badge>
            {campaign.human_id ? (
              <Badge variant="outline" className="font-mono text-xs">
                {campaign.human_id}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {campaign.slug}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canUpdateCampaign && campaign.status !== "archived" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditCampaignOpen(true)}
            >
              <Pencil className="size-4" aria-hidden /> Edit
            </Button>
          ) : null}
          {possibleCampaignTransitions.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  Status actions
                  <ChevronDown className="size-3" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {possibleCampaignTransitions.map((tr) => (
                  <DropdownMenuItem
                    key={tr.t}
                    onSelect={() => setCampaignTransition(tr.t)}
                  >
                    {tr.icon} {tr.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {campaign.status !== "archived" && canArchiveCampaign ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCampaignArchiveConfirm("archive")}
            >
              <ArchiveIcon className="size-4" aria-hidden /> Archive
            </Button>
          ) : null}
          {campaign.status === "archived" && canRestoreCampaign ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCampaignArchiveConfirm("restore")}
            >
              <ArchiveRestore className="size-4" aria-hidden /> Restore
            </Button>
          ) : null}
        </div>
      </header>

      {/* ============ Metadata ============ */}
      <Card>
        <CardContent className="grid gap-4 pt-6 text-sm md:grid-cols-3">
          <MetaCell label="Brand" value={
            campaign.brand ? (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="size-2 rounded-full"
                  style={{
                    backgroundColor: campaign.brand.color ?? "#64748B",
                  }}
                />
                {campaign.brand.name}
              </span>
            ) : "—"
          } />
          <MetaCell label="Offer" value={
            campaign.offer ? (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="size-2 rounded-full"
                  style={{
                    backgroundColor: campaign.offer.color ?? "#64748B",
                  }}
                />
                {campaign.offer.name}
              </span>
            ) : "—"
          } />
          <MetaCell
            label="Routing"
            value={campaign.routing_type?.name ?? "—"}
          />
          <MetaCell
            label="Traffic"
            value={campaign.traffic_type?.name ?? "—"}
          />
          <MetaCell
            label="Assigned to"
            value={memberLabel(campaign.assigned_to_user_id) ?? "Unassigned"}
          />
          <MetaCell
            label="Created by"
            value={memberLabel(campaign.created_by_user_id) ?? "—"}
          />
          <MetaCell
            label="Created"
            value={format(new Date(campaign.created_at), "MMM d, yyyy")}
          />
          <MetaCell
            label="Start / End"
            value={
              campaign.start_date || campaign.end_date
                ? `${campaign.start_date ?? "—"} → ${campaign.end_date ?? "—"}`
                : "—"
            }
          />
          <MetaCell
            label="Audience"
            value={
              <span
                title={`Segments: ${campaign.audience_segment_ids.join(", ") || "—"}\nFilters: ${JSON.stringify(campaign.audience_filters)}`}
              >
                {campaign.audience_snapshot_count.toLocaleString()} contacts frozen
              </span>
            }
          />
        </CardContent>
        {campaign.notes ? (
          <CardContent className="border-t pt-4 text-sm">
            <div className="text-xs uppercase text-muted-foreground">Notes</div>
            <p className="mt-1 whitespace-pre-wrap">{campaign.notes}</p>
          </CardContent>
        ) : null}
      </Card>

      {/* ============ Stages section ============ */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium">Stages</h2>
            <p className="text-sm text-muted-foreground">{rollupSubtitle}</p>
          </div>
          {canCreateStage && campaign.status !== "archived" ? (
            <Button onClick={() => setAddStageOpen(true)}>
              <Plus className="size-4" aria-hidden /> Add stage
            </Button>
          ) : null}
        </div>

        {stages.length === 0 && !stagesApi.isLoading ? (
          <div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-16 text-center">
            <Send className="size-12 text-muted-foreground/40" aria-hidden />
            <div className="space-y-1">
              <p className="text-sm font-medium">No stages yet</p>
              <p className="text-sm text-muted-foreground">
                Each stage is a discrete SMS send to a slice of the frozen
                audience.
              </p>
            </div>
            {canCreateStage && campaign.status !== "archived" ? (
              <Button onClick={() => setAddStageOpen(true)}>
                <Plus className="size-4" aria-hidden /> Add your first stage
              </Button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {ALL_STAGE_STATUSES.map((s) => {
                  const active = stageFilters.statuses.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => {
                        const set = new Set(stageFilters.statuses);
                        if (set.has(s)) set.delete(s);
                        else set.add(s);
                        updateStageFilters({
                          statuses: Array.from(set) as StageStatus[],
                        });
                      }}
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
                  id="stages-show-archived"
                  checked={stageFilters.showArchived}
                  onCheckedChange={(checked) =>
                    updateStageFilters({ showArchived: checked })
                  }
                />
                <Label htmlFor="stages-show-archived" className="text-sm">
                  Show archived
                </Label>
              </div>
              {(stageFilters.statuses.length > 0 ||
                stageFilters.showArchived) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => resetStageFilters()}
                >
                  Reset filters
                </Button>
              ) : null}
            </div>

            {stagesError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
                <p className="text-destructive">
                  Couldn&apos;t load stages: {stagesError}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={refetchStages}
                >
                  Retry
                </Button>
              </div>
            ) : (
              <DataTable<Stage>
                data={stages}
                columns={stageColumns}
                isLoading={stagesApi.isLoading}
                pageIndex={0}
                pageSize={stages.length || 20}
                totalCount={stages.length}
                onPageChange={() => {}}
                onPageSizeChange={() => {}}
                sortBy="stage_number"
                sortDir="asc"
                onSortChange={() => {}}
                onRowClick={
                  canUpdateStage ? (s) => setEditingStage(s) : undefined
                }
              />
            )}
          </>
        )}
      </section>

      {/* ============ Dialogs ============ */}
      <Dialog open={editCampaignOpen} onOpenChange={setEditCampaignOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Edit campaign</DialogTitle>
            <DialogDescription>{campaign.name}</DialogDescription>
          </DialogHeader>
          <CampaignForm
            key={`edit-${campaign.id}`}
            mode="edit"
            initialValues={editValues}
            currentStatus={campaign.status}
            onSubmitDraft={handleCampaignEdit}
            onSubmitActivate={handleCampaignEdit}
            onCancel={() => setEditCampaignOpen(false)}
            isSubmittingDraft={false}
            isSubmittingActivate={campaignUpdateApi.isLoading}
          />
        </DialogContent>
      </Dialog>

      <StatusChangeDialog
        transition={campaignTransition}
        campaignName={campaign.name}
        isPending={campaignStatusApi.isLoading}
        onCancel={() => setCampaignTransition(null)}
        onConfirm={handleCampaignTransition}
      />

      <AlertDialog
        open={campaignArchiveConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setCampaignArchiveConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {campaignArchiveConfirm === "archive"
                ? "Archive this campaign?"
                : "Restore this campaign?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {campaignArchiveConfirm === "archive"
                ? "Archived campaigns are hidden from the active list. Data is preserved."
                : "Restoring brings the campaign back as a draft so any subsequent activation is an explicit action."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={
                campaignArchiveApi.isLoading || campaignRestoreApi.isLoading
              }
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleCampaignArchiveRestore();
              }}
              disabled={
                campaignArchiveApi.isLoading || campaignRestoreApi.isLoading
              }
            >
              {campaignArchiveConfirm === "archive" ? "Archive" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={addStageOpen} onOpenChange={setAddStageOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Add stage</DialogTitle>
            <DialogDescription>
              A new SMS send under {campaign.name}.
            </DialogDescription>
          </DialogHeader>
          <StageForm
            mode="create"
            campaignId={campaign.id}
            campaign={campaign}
            onSubmit={handleStageCreate}
            onCancel={() => setAddStageOpen(false)}
            isSubmitting={stageCreateApi.isLoading}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={editingStage !== null}
        onOpenChange={(open) => {
          if (!open) setEditingStage(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Edit stage</DialogTitle>
            <DialogDescription>
              {editingStage
                ? `Stage ${editingStage.stage_number}${editingStage.label ? ` · ${editingStage.label}` : ""}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {editingStage && editStageValues ? (
            <StageForm
              key={`edit-stage-${editingStage.id}`}
              mode="edit"
              campaignId={campaign.id}
              campaign={campaign}
              initialValues={editStageValues}
              onSubmit={handleStageEdit}
              onCancel={() => setEditingStage(null)}
              isSubmitting={stageUpdateApi.isLoading}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <StageStatusChangeDialog
        transition={stageTransitionTarget?.transition ?? null}
        stageLabel={
          stageTransitionTarget
            ? `Stage ${stageTransitionTarget.stage.stage_number}${stageTransitionTarget.stage.label ? ` · ${stageTransitionTarget.stage.label}` : ""}`
            : null
        }
        isPending={stageStatusApi.isLoading}
        onCancel={() => setStageTransitionTarget(null)}
        onConfirm={handleStageTransition}
      />

      <AlertDialog
        open={stageArchiveConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setStageArchiveConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {stageArchiveConfirm?.kind === "archive"
                ? "Archive this stage?"
                : "Restore this stage?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {stageArchiveConfirm?.kind === "archive"
                ? "Archived stages are hidden from the active list. Data is preserved."
                : "Restoring brings the stage back as a draft."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={
                stageArchiveApi.isLoading || stageRestoreApi.isLoading
              }
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleStageArchiveRestore();
              }}
              disabled={
                stageArchiveApi.isLoading || stageRestoreApi.isLoading
              }
            >
              {stageArchiveConfirm?.kind === "archive" ? "Archive" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// =============== Sub-components ===============

function BackLink() {
  return (
    <Link
      href="/campaigns"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-3" aria-hidden /> All campaigns
    </Link>
  );
}

function MetaCell({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="grid gap-0.5">
      <span className="text-xs uppercase text-muted-foreground">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
}
