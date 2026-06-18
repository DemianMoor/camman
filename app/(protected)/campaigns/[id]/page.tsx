"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  ArchiveRestore,
  Archive as ArchiveIcon,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  History,
  MoreHorizontal,
  Pause,
  Pencil,
  PenLine,
  Play,
  Plus,
  Send,
  Split,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";

import { type AudienceFilters } from "@/components/campaigns/campaign-form";
import { CampaignSendMode } from "@/components/campaigns/campaign-send-mode";
import { CampaignActivitySection } from "@/components/campaigns/campaign-activity-section";
import { ClickReportSection } from "@/components/campaigns/click-report-section";
import { ExportClickersDialog } from "@/components/campaigns/export-clickers-dialog";
import { StageSendPanel } from "@/components/campaigns/stage-send-panel";
import {
  StagePrepareDialog,
  type PrepareTarget,
} from "@/components/campaigns/stage-prepare-dialog";
import { StageStatusLegend } from "@/components/campaigns/stage-status-legend";
import {
  deriveStageOperationalStatus,
  STAGE_STATUS_META,
} from "@/lib/stages/stage-status";
import { ImportHistoryDialog } from "@/components/campaigns/import-history-dialog";
import { ManualResultsForm } from "@/components/campaigns/manual-results-form";
import { PhoneUploadForm } from "@/components/phone-upload-form";
import {
  formatRevenue,
  formatRoi,
  stageRevenue,
  stageRoi,
} from "@/lib/stage-results";
import { ResultsImportForm } from "@/components/campaigns/results-import-form";
import { StageInlineEditor } from "@/components/campaigns/stage-inline-creator";
import {
  StatusChangeDialog,
  type CampaignTransition,
  transitionToStatus,
} from "@/components/campaigns/status-change-dialog";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/lib/api/toast-error";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { formatPhoneInternational } from "@/lib/phone-validation";
import { cn } from "@/lib/utils";

// =============== Types ===============

type Info = { id: number; name: string; color: string | null };
type Offer = Info & {
  sales_pages?: { label: string; url: string }[];
  base_url?: string | null;
  postfix?: string | null;
};
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
  audience_contact_group_ids: number[];
  audience_filters: AudienceFilters;
  audience_snapshot_count: number;
  audience_cap: number | null;
  exclude_in_use_contacts: boolean;
  start_date: string | null;
  end_date: string | null;
  status: CampaignStatus;
  status_changed_at: string;
  tracking_id: string | null;
  link_mode: "manual" | "tracked";
  archived_at: string | null;
  created_at: string;
  brand: (Info & { short_domain: string | null }) | null;
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
  short_url: string | null;
  full_url: string | null;
  utm_tag_ids: number[] | null;
  stop_text: string;
  include_clickers: boolean;
  exclude_clickers: boolean;
  include_no_status: boolean;
  scheduled_at: string | null;
  sent_at: string | null;
  schedule_missed_at: string | null;
  send_approved: boolean;
  status: StageStatus;
  sms_count: number;
  total_cost: string;
  delivered_count: number;
  opt_out_count: number;
  // Inbound STOP opt-outs attributed to this stage via the poller's 72h-window
  // match (migration 0075) — campaign_stages.inbound_opt_out_count, the same
  // source the Reports page reads. Distinct from the import-fed opt_out_count.
  inbound_stop_count: number;
  click_count: number;
  late_click_count: number;
  scrubbed_count: number;
  bounced_count: number;
  checkout_click_count: number;
  sales_count: number;
  sales_payout_each: string | null;
  notes: string | null;
  tracking_id: string | null;
  split_index: number | null;
  split_total: number | null;
  // Behavioral lane (step 5). behavioral_tier NULL ⇒ ordinary stage; 0/1/2 ⇒ a
  // lane hanging off parent_stage_id (the prior position). audience_count is the
  // LIVE lane preview for lanes (alive + exact tier − opt-outs, converted out).
  behavioral_tier: number | null;
  parent_stage_id: number | null;
  archived_at: string | null;
  created_at: string;
  audience_count: number;
  // WS4 §0: campaign link mode (propagated from the parent) + stage_sends
  // materialization counts. Drive the derived operational status / row color.
  link_mode: "manual" | "tracked";
  send_counts: {
    total: number;
    pending: number;
    sending: number;
    sent: number;
    failed: number;
  };
  creative: { id: number; slug: string; text: string } | null;
  provider: Info | null;
  provider_phone: { id: number; phone_number: string } | null;
  offer: { id: number; name: string; color: string | null; payout_cpa: string | null } | null;
};

type StagesListResponse = {
  data: Stage[];
  totalCount: number;
  // Campaign-level DISTINCT contacts attributed an inbound STOP (migration 0075).
  inbound_stop_contacts: number;
};

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

// Behavioral-lane tier → human label + chip color. Tier 3 (converted) is never
// a lane — those contacts exit the sequence — so it's intentionally absent.
const BEHAVIORAL_TIER_META: Record<
  number,
  { label: string; className: string }
> = {
  0: {
    label: "Ignored",
    className:
      "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300",
  },
  1: {
    label: "Clicked",
    className:
      "border-sky-200 bg-sky-100 text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200",
  },
  2: {
    label: "Reached offer",
    className:
      "border-violet-200 bg-violet-100 text-violet-800 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-200",
  },
};

// Stage status is freely assignable among the non-archived states via an
// inline dropdown, so an operator can record the resulting status directly.
// (archived is reached through the Archive action, not this list.)
const STAGE_STATUS_OPTIONS: StatusOption<ActiveStageStatus>[] = [
  { value: "draft", label: "Draft", color: "gray" },
  { value: "pending", label: "Pending", color: "amber" },
  { value: "sent", label: "Sent", color: "sky" },
  { value: "success", label: "Success", color: "green" },
  { value: "cancelled", label: "Cancelled", color: "gray" },
  { value: "failed", label: "Failed", color: "red" },
];

type StagesFilters = {
  statuses: StageStatus[];
  showArchived: boolean;
  pageSize: number;
};

const DEFAULT_STAGE_FILTERS: StagesFilters = {
  statuses: [],
  showArchived: false,
  pageSize: 20,
};

export default function CampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const campaignId = Number(params.id);
  const { auth, can } = useAuth();

  const campaignApi = useApiCall<CampaignDetail>();
  const stagesApi = useApiCall<StagesListResponse>();
  const membersApi = useApiCall<{ data: Member[] }>();
  const campaignStatusApi = useApiCall<CampaignDetail>();
  const campaignArchiveApi = useApiCall<CampaignDetail>();
  const campaignRestoreApi = useApiCall<CampaignDetail>();
  const stageStatusApi = useApiCall<Stage>();
  const stageArchiveApi = useApiCall<Stage>();
  const stageRestoreApi = useApiCall<Stage>();
  const stageDuplicateApi = useApiCall<Stage>();
  const behavioralSplitApi = useApiCall<{
    parent_stage_id: number;
    lane_stage_ids: number[];
    tiers: (number | null)[];
  }>();

  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [campaignTick, setCampaignTick] = useState(0);
  const refetchCampaign = useCallback(
    () => setCampaignTick((n) => n + 1),
    [],
  );

  const [stages, setStages] = useState<Stage[]>([]);
  // Campaign-level distinct contacts who STOPped (server-computed; see the
  // stages list endpoint). Drives the "Inbound STOPs" rollup metric.
  const [inboundStopContacts, setInboundStopContacts] = useState(0);
  const [stagesError, setStagesError] = useState<string | null>(null);
  const [stagesTick, setStagesTick] = useState(0);
  const refetchStages = useCallback(() => setStagesTick((n) => n + 1), []);

  // Bulk-selection state for stages. Set of stage IDs currently checked.
  // Cleared on every fresh stages fetch so stale ids don't survive a
  // filter change.
  const [selectedStageIds, setSelectedStageIds] = useState<Set<number>>(
    new Set(),
  );
  const [stageBulkBusy, setStageBulkBusy] = useState(false);
  useEffect(() => {
    setSelectedStageIds(new Set());
  }, [stages]);
  const stageBulkApi = useApiCall<{
    succeeded: number[];
    failed: { id: number; reason: string }[];
  }>();
  async function runStageBulk(
    target: "success" | "failed" | "cancelled" | "archived",
  ) {
    if (selectedStageIds.size === 0) return;
    setStageBulkBusy(true);
    const result = await stageBulkApi.execute(
      `/api/campaigns/${campaignId}/stages/bulk-status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage_ids: Array.from(selectedStageIds),
          target_status: target,
          confirm: true,
        }),
      },
    );
    setStageBulkBusy(false);
    if (!result.ok) {
      toastApiError(result, "Couldn't apply bulk action");
      return;
    }
    const { succeeded, failed } = result.data;
    if (succeeded.length > 0 && failed.length === 0) {
      toast.success(`${succeeded.length} stages updated`);
    } else if (succeeded.length > 0) {
      toast.warning(
        `${succeeded.length} updated, ${failed.length} skipped: ${failed.map((f) => f.reason).slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}`,
      );
    } else {
      toast.error(
        `0 updated, ${failed.length} skipped: ${failed.map((f) => f.reason).slice(0, 3).join(", ")}`,
      );
    }
    setSelectedStageIds(new Set());
    refetchStages();
  }

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
      if (r.ok) {
        setStages(r.data.data);
        setInboundStopContacts(r.data.inbound_stop_contacts ?? 0);
      } else setStagesError(r.error);
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
  const [campaignTransition, setCampaignTransition] =
    useState<CampaignTransition | null>(null);
  const [campaignArchiveConfirm, setCampaignArchiveConfirm] = useState<
    null | "archive" | "restore"
  >(null);

  const [addStageOpen, setAddStageOpen] = useState(false);
  const [editingStage, setEditingStage] = useState<Stage | null>(null);

  // Deep-link from the Reports page: `?stage=<id>` opens that stage's editor
  // once the stages list has loaded. Captured at first render, consumed once.
  const [pendingStageFocus, setPendingStageFocus] = useState<number | null>(
    () => {
      if (typeof window === "undefined") return null;
      const raw = new URLSearchParams(window.location.search).get("stage");
      const id = raw ? Number(raw) : NaN;
      return Number.isInteger(id) && id > 0 ? id : null;
    },
  );
  useEffect(() => {
    if (pendingStageFocus == null || stages.length === 0) return;
    const target = stages.find((s) => s.id === pendingStageFocus);
    if (target) {
      setEditingStage(target);
      setAddStageOpen(true);
    }
    setPendingStageFocus(null);
  }, [pendingStageFocus, stages]);
  const [stageArchiveConfirm, setStageArchiveConfirm] = useState<{
    kind: "archive" | "restore";
    stage: Stage;
  } | null>(null);
  const [behavioralSplitStage, setBehavioralSplitStage] =
    useState<Stage | null>(null);
  const [importStage, setImportStage] = useState<Stage | null>(null);
  const [manualStage, setManualStage] = useState<Stage | null>(null);
  const [historyStage, setHistoryStage] = useState<Stage | null>(null);
  const [sendStage, setSendStage] = useState<Stage | null>(null);
  // WS4 §A4: one-click Prepare target from the stages-list row (Orange rows).
  const [prepareTarget, setPrepareTarget] = useState<PrepareTarget | null>(null);
  const [uploadContactsOpen, setUploadContactsOpen] = useState(false);

  const canUpdateCampaign = can("campaigns.update");
  const canUploadContacts = canUpdateCampaign && can("contacts.upload");
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
  const canImportResults = can("result_imports.create");
  const canViewImports = can("result_imports.view");

  // ============ Handlers ============

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

  async function handleStageStatusChange(
    stage: Stage,
    next: ActiveStageStatus,
  ) {
    const result = await stageStatusApi.execute(
      `/api/campaigns/${campaignId}/stages/${stage.id}/status`,
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
    toast.success(`Stage marked ${next}`);
    refetchStages();
    refetchCampaign();
  }

  async function handleStageDuplicate(stage: Stage) {
    const result = await stageDuplicateApi.execute(
      `/api/campaigns/${campaignId}/stages/${stage.id}/duplicate`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't duplicate stage");
      return;
    }
    toast.success(`Stage ${result.data.stage_number} created`);
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

  async function handleBehavioralSplit() {
    if (!behavioralSplitStage) return;
    const result = await behavioralSplitApi.execute(
      `/api/campaigns/${campaignId}/stages/${behavioralSplitStage.id}/behavioral-split`,
      { method: "POST" },
    );
    if (!result.ok) {
      toastApiError(result, "Couldn't create behavioral lanes");
      return;
    }
    toast.success("Behavioral split — 3 lanes created (Ignored / Clicked / Reached offer)");
    setBehavioralSplitStage(null);
    refetchStages();
    refetchCampaign();
  }

  // ============ Behavioral-lane derivations ============
  // parent_stage_id → its lane stages, and id → stage_number, so lane rows can
  // show "from #N" and parent rows can show a "N lanes" badge. Derived from the
  // already-loaded stages list — no extra fetch.
  const lanesByParent = useMemo(() => {
    const m = new Map<number, Stage[]>();
    for (const s of stages) {
      if (s.parent_stage_id != null) {
        const arr = m.get(s.parent_stage_id) ?? [];
        arr.push(s);
        m.set(s.parent_stage_id, arr);
      }
    }
    return m;
  }, [stages]);
  const stageNumberById = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of stages) m.set(s.id, s.stage_number);
    return m;
  }, [stages]);
  const hasBehavioralLanes = lanesByParent.size > 0;

  // ============ Stage columns ============

  function activityFilterLabel(s: Stage): string {
    if (s.include_clickers) return "Clickers only";
    if (s.exclude_clickers) return "Excluding clickers";
    return "All";
  }

  // WS4 §0: derived operational status for a stage (null = off the model:
  // manual campaign or archived stage → falls back to the manual-status color).
  function stageOpStatus(s: Stage) {
    return deriveStageOperationalStatus({
      linkMode: s.link_mode,
      status: s.status,
      scheduledAt: s.scheduled_at,
      sentAt: s.sent_at,
      scheduleMissedAt: s.schedule_missed_at,
      counts: s.send_counts,
    });
  }

  const stageColumns = useMemo<ColumnDef<Stage>[]>(
    () => [
      {
        id: "select",
        header: () => null,
        enableSorting: false,
        cell: ({ row }) => (
          <input
            type="checkbox"
            checked={selectedStageIds.has(row.original.id)}
            onClick={(e) => e.stopPropagation()}
            onChange={() =>
              setSelectedStageIds((prev) => {
                const next = new Set(prev);
                if (next.has(row.original.id)) next.delete(row.original.id);
                else next.add(row.original.id);
                return next;
              })
            }
            aria-label="Select stage"
            className="size-4 cursor-pointer"
          />
        ),
      },
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
        cell: ({ row }) => {
          const s = row.original;
          const tierMeta =
            s.behavioral_tier != null
              ? BEHAVIORAL_TIER_META[s.behavioral_tier]
              : null;
          const parentNumber =
            s.parent_stage_id != null
              ? stageNumberById.get(s.parent_stage_id)
              : undefined;
          const laneCount = lanesByParent.get(s.id)?.length ?? 0;
          return (
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Lane chip: a lane belongs to a parent position. The ↳ + "from #N"
                  makes the parent→lanes relationship obvious in the flat table. */}
              {tierMeta ? (
                <Badge
                  variant="outline"
                  className={cn("text-[10px]", tierMeta.className)}
                  title={
                    parentNumber != null
                      ? `Behavioral lane (tier ${s.behavioral_tier}) from stage #${parentNumber}`
                      : `Behavioral lane (tier ${s.behavioral_tier})`
                  }
                >
                  ↳ {tierMeta.label}
                  {parentNumber != null ? (
                    <span className="ml-1 opacity-70">· from #{parentNumber}</span>
                  ) : null}
                </Badge>
              ) : null}
              {row.original.label ? (
                <span className="text-sm">{row.original.label}</span>
              ) : (
                <span className="text-sm text-muted-foreground">(no label)</span>
              )}
              {row.original.split_total && row.original.split_index ? (
                <Badge variant="secondary" className="text-[10px]">
                  Split {row.original.split_index}/{row.original.split_total}
                </Badge>
              ) : null}
              {/* Parent position: announce that this stage spawned lanes. */}
              {laneCount > 0 ? (
                <Badge variant="secondary" className="text-[10px]">
                  {laneCount} behavioral lane{laneCount === 1 ? "" : "s"}
                </Badge>
              ) : null}
            </div>
            {row.original.tracking_id ? (
              <button
                type="button"
                className="font-mono text-[10px] text-muted-foreground hover:text-foreground"
                title="Click to copy"
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard
                    .writeText(row.original.tracking_id as string)
                    .then(() => toast.success("Tracking ID copied"))
                    .catch(() => toast.error("Couldn't copy"));
                }}
              >
                {row.original.tracking_id}
              </button>
            ) : null}
          </div>
          );
        },
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
        id: "audience_count",
        header: "Audience",
        accessorKey: "audience_count",
        enableSorting: true,
        cell: ({ row }) => {
          const s = row.original;
          const n = s.audience_count;
          // Lane rows: the LIVE behavioral preview. Always show the number
          // (even 0 — honest "no one alive at this tier yet", not "no data")
          // with a "live" hint, so it reads as a moving target, not a snapshot.
          if (s.behavioral_tier != null) {
            return (
              <span
                className="font-mono text-sm tabular-nums"
                title="Live preview — alive + at this exact tier, minus opt-outs (converted exit). Changes until send."
              >
                {n.toLocaleString()}
                <span className="ml-1 align-middle text-[9px] uppercase tracking-wide text-muted-foreground">
                  live
                </span>
              </span>
            );
          }
          if (n === 0) return <span className="text-muted-foreground">—</span>;
          return (
            <span className="font-mono text-sm tabular-nums">
              {n.toLocaleString()}
            </span>
          );
        },
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
        id: "send_state",
        header: "Send",
        enableSorting: false,
        cell: ({ row }) => {
          const s = row.original;
          const op = stageOpStatus(s);
          if (!op) return <span className="text-muted-foreground">—</span>;
          const meta = STAGE_STATUS_META[op];
          return (
            <div className="flex flex-col items-start gap-1">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium",
                  meta.badgeClass,
                )}
                title={meta.meaning}
              >
                <span className={cn("size-1.5 rounded-full", meta.dotClass)} />
                {meta.label}
              </span>
              {/* §A4: one-click Prepare on Orange rows — opens the shared popup
                  (full readiness checklist) in place, no editor. */}
              {op === "scheduled_unprepared" && canActivate ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[11px]"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPrepareTarget({
                      campaignId,
                      stageId: s.id,
                      stageLabel: s.label,
                      scheduledAt: s.scheduled_at,
                      scheduleMissedAt: s.schedule_missed_at,
                    });
                  }}
                >
                  <Send className="size-3" aria-hidden /> Prepare
                </Button>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        enableSorting: false,
        cell: ({ row }) => {
          const s = row.original;
          if (s.status === "archived") {
            return (
              <Badge
                className={cn("capitalize", STAGE_STATUS_COLOR.archived)}
              >
                archived
              </Badge>
            );
          }
          // Tracked stages are sent by the API pipeline, which owns 'sent'
          // (and its sent_at fire-lock). Marking them 'sent' manually is
          // rejected server-side, so hide the option here.
          const statusOptions =
            campaign?.link_mode === "tracked"
              ? STAGE_STATUS_OPTIONS.filter((o) => o.value !== "sent")
              : STAGE_STATUS_OPTIONS;
          return (
            <StatusDropdown<ActiveStageStatus>
              current={s.status as ActiveStageStatus}
              options={statusOptions}
              onChange={(next) => handleStageStatusChange(s, next)}
              isUpdating={stageStatusApi.isLoading}
              isTerminal={!canSendStage}
            />
          );
        },
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
          const {
            sms_count: sms,
            delivered_count: delivered,
            opt_out_count: oo,
            click_count: cl,
            late_click_count: lc,
          } = row.original;
          // Results are considered entered (manually or imported) once any
          // send/outcome counter is non-zero.
          const hasResults =
            sms > 0 || delivered > 0 || oo > 0 || cl > 0 || lc > 0;
          if (!hasResults)
            return <span className="text-muted-foreground">—</span>;
          // Late clickers supersede 1st-day clickers once a follow-up report
          // arrives; otherwise use the 1st-day count.
          const clicks = lc > 0 ? lc : cl;
          // Rate denominator: delivered, falling back to SMS sent.
          const denom = delivered > 0 ? delivered : sms;
          const pct = (n: number) =>
            denom > 0 ? `${((n / denom) * 100).toFixed(1)}%` : "—";
          return (
            <span className="font-mono text-xs tabular-nums">
              Clicks: {clicks} · CTR: {pct(clicks)} · OptOut: {pct(oo)}
            </span>
          );
        },
      },
      {
        id: "revenue",
        header: "Revenue / ROI",
        enableSorting: false,
        cell: ({ row }) => {
          const s = row.original;
          if (s.sales_count === 0)
            return <span className="text-muted-foreground">—</span>;
          const revenue = stageRevenue(
            s.sales_count,
            s.sales_payout_each === null ? null : Number(s.sales_payout_each),
          );
          const roi = stageRoi(revenue, Number(s.total_cost));
          return (
            <span className="font-mono text-xs tabular-nums">
              {formatRevenue(revenue)} · {formatRoi(roi)}
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
          const audienceEmpty = s.audience_count === 0;
          const exportTitle = audienceEmpty
            ? "Stage has no audience — adjust filters to enable export."
            : undefined;
          if (!showEdit && !showArchive && !showRestore) return null;
          return (
            <div className="flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={audienceEmpty}
                title={
                  exportTitle ?? "Export this stage's phones as a CSV"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  if (audienceEmpty) return;
                  window.open(
                    `/api/campaigns/${campaignId}/stages/${s.id}/export-phones`,
                    "_blank",
                    "noopener",
                  );
                }}
              >
                <Download className="size-4" aria-hidden />
                <span className="sr-only sm:not-sr-only">Export phones</span>
              </Button>
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
                      onSelect={() => {
                        setEditingStage(s);
                        setAddStageOpen(true);
                      }}
                    >
                      <Pencil className="size-4" aria-hidden /> Edit
                    </DropdownMenuItem>
                  ) : null}
                  {canCreateStage ? (
                    <DropdownMenuItem
                      onSelect={() => void handleStageDuplicate(s)}
                    >
                      <Copy className="size-4" aria-hidden /> Duplicate
                    </DropdownMenuItem>
                  ) : null}
                  {/* Behavioral split lives in the stage editor's audience block
                      (beside the A/B "Split for A/B test…" button), not here —
                      both split actions sit in the same place. */}
                  {canActivate ? (
                    <DropdownMenuItem onSelect={() => setSendStage(s)}>
                      <Send className="size-4" aria-hidden /> Send…
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuSeparator />
                  {canImportResults ? (
                    <DropdownMenuItem onSelect={() => setImportStage(s)}>
                      <Upload className="size-4" aria-hidden /> Import results
                      (CSV)
                    </DropdownMenuItem>
                  ) : null}
                  {canImportResults ? (
                    <DropdownMenuItem onSelect={() => setManualStage(s)}>
                      <PenLine className="size-4" aria-hidden /> Enter results
                      manually
                    </DropdownMenuItem>
                  ) : null}
                  {canViewImports ? (
                    <DropdownMenuItem onSelect={() => setHistoryStage(s)}>
                      <History className="size-4" aria-hidden /> View import
                      history
                    </DropdownMenuItem>
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
    [
      campaignId,
      campaign?.link_mode,
      canUpdateStage,
      canArchiveStage,
      canRestoreStage,
      canSendStage,
      canActivate,
      canImportResults,
      canViewImports,
      canCreateStage,
      selectedStageIds,
      stageStatusApi.isLoading,
      lanesByParent,
      stageNumberById,
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stageOpStatus and
    // setPrepareTarget are stable; STAGE_STATUS_META is a module constant.
  );

  // Aggregate results across non-archived stages. Shown above the stage
  // table once there's any send activity. Archived stages are excluded so
  // operators can keep historical stages around without inflating totals.
  const campaignTotals = useMemo(() => {
    let sms = 0;
    let delivered = 0;
    let optOuts = 0;
    let clickers = 0;
    let lateClickers = 0;
    let scrubbed = 0;
    let bounced = 0;
    let checkoutClicks = 0;
    let sales = 0;
    let cost = 0;
    // Sum revenue only over stages with a known per-sale payout so the rollup
    // ROI stays trustworthy. revenueKnown stays false until at least one stage
    // contributes, so we can render "—" rather than a misleading $0.
    let revenue = 0;
    let revenueKnown = false;
    for (const s of stages) {
      if (s.archived_at) continue;
      sms += s.sms_count;
      delivered += s.delivered_count;
      optOuts += s.opt_out_count;
      clickers += s.click_count;
      lateClickers += s.late_click_count;
      scrubbed += s.scrubbed_count;
      bounced += s.bounced_count;
      checkoutClicks += s.checkout_click_count;
      sales += s.sales_count;
      cost += Number(s.total_cost);
      const r = stageRevenue(
        s.sales_count,
        s.sales_payout_each === null ? null : Number(s.sales_payout_each),
      );
      if (r !== null) {
        revenue += r;
        revenueKnown = true;
      }
    }
    return {
      sms,
      delivered,
      optOuts,
      // Campaign-level DISTINCT contacts who STOPped (server-computed) — not a
      // sum of per-stage credits, which window-attribution would over-count.
      inboundStops: inboundStopContacts,
      clickers,
      lateClickers,
      scrubbed,
      bounced,
      checkoutClicks,
      sales,
      cost,
      revenue: revenueKnown ? revenue : null,
    };
  }, [stages, inboundStopContacts]);
  const hasResults =
    campaignTotals.sms > 0 || campaignTotals.inboundStops > 0;

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
            <Button asChild variant="outline" size="sm">
              <Link href={`/campaigns/${campaign.id}/edit`}>
                <Pencil className="size-4" aria-hidden /> Edit
              </Link>
            </Button>
          ) : null}
          {/* Upload contacts straight onto a draft campaign's audience via CSV
              or paste. Draft-only: the audience snapshot freezes at activation. */}
          {canUploadContacts && campaign.status === "draft" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setUploadContactsOpen(true)}
            >
              <Upload className="size-4" aria-hidden /> Upload contacts
            </Button>
          ) : null}
          {/* Union-of-all-stages export. Disabled for drafts because the
              audience snapshot is computed at activation time — no stage
              rows yet. Also hidden when every stage is archived, since
              the endpoint excludes archived stages anyway. */}
          {campaign.status !== "draft" &&
          stages.some((s) => s.status !== "archived") ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                window.open(
                  `/api/campaigns/${campaignId}/export-all-phones`,
                  "_blank",
                  "noopener",
                )
              }
              title="Export the union of all non-archived stages' phones as one CSV"
            >
              <Download className="size-4" aria-hidden /> Export all phones
            </Button>
          ) : null}
          {/* Tracked-clicker export — only for tracked campaigns, where clicks
              are attributed via minted links. Manual campaigns have no tracked
              clicks (use the manual clicker CSV workflow instead). */}
          {campaign.link_mode === "tracked" &&
          campaign.status !== "draft" ? (
            <ExportClickersDialog
              campaignId={campaign.id}
              stages={stages}
            />
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

      {/* ============ Send method (Manual vs API/tracked) ============ */}
      <CampaignSendMode
        campaignId={campaign.id}
        linkMode={campaign.link_mode}
        brandName={campaign.brand?.name ?? null}
        brandShortDomain={campaign.brand?.short_domain ?? null}
        canEdit={canUpdateCampaign}
        onChanged={refetchCampaign}
      />

      {/* ============ Metadata (compact two-line summary + expand) ============ */}
      <CampaignMetaCompact
        campaign={campaign}
        memberLabel={memberLabel}
      />

      {/* ============ Stages section ============ */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-medium">Stages</h2>
            <p className="text-sm text-muted-foreground">{rollupSubtitle}</p>
          </div>
          {campaign.link_mode === "tracked" ? <StageStatusLegend /> : null}
        </div>

        {/* Behavioral-lane explainer — shown once any lanes exist so the
            operator understands why lane counts don't add up to the pool. */}
        {hasBehavioralLanes ? (
          <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <Split className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <p>
              <span className="font-medium text-foreground">
                Behavioral lanes
              </span>{" "}
              route each recipient by their{" "}
              <span className="font-medium">current</span> tier in this campaign
              — <span className="font-medium">Ignored</span> /{" "}
              <span className="font-medium">Clicked</span> /{" "}
              <span className="font-medium">Reached offer</span>. A contact lands
              in exactly one lane (their highest tier reached).{" "}
              <span className="font-medium">Converted</span> contacts exit the
              sequence (no lane) and opted-out contacts are suppressed, so lane
              counts won&apos;t sum to the full audience. The{" "}
              <span className="font-mono">live</span> audience numbers are a
              preview computed from current behavior — they change until the
              stage is sent.
            </p>
          </div>
        ) : null}

        {hasResults ? (
          <Card>
            <CardContent className="grid grid-cols-2 gap-3 pt-6 sm:grid-cols-4 lg:grid-cols-6">
              <TotalsMetric label="SMS sent" value={campaignTotals.sms} />
              <TotalsMetric
                label="Delivered"
                value={campaignTotals.delivered}
              />
              <TotalsMetric
                label="Opt-outs"
                value={campaignTotals.optOuts}
              />
              <TotalsMetric
                label="Inbound STOPs"
                value={campaignTotals.inboundStops}
              />
              <TotalsMetric
                label="Clicker 1st Day"
                value={campaignTotals.clickers}
              />
              <TotalsMetric
                label="Late Clickers"
                value={campaignTotals.lateClickers}
              />
              <TotalsMetric
                label="Scrubbed"
                value={campaignTotals.scrubbed}
              />
              <TotalsMetric
                label="Bounced"
                value={campaignTotals.bounced}
              />
              <TotalsMetric
                label="Checkout Clicks"
                value={campaignTotals.checkoutClicks}
              />
              <TotalsMetric label="Sales" value={campaignTotals.sales} />
              <TotalsMetric
                label="Revenue"
                value={formatRevenue(campaignTotals.revenue)}
                raw
              />
              <TotalsMetric
                label="ROI"
                value={formatRoi(stageRoi(campaignTotals.revenue, campaignTotals.cost))}
                raw
              />
              <TotalsMetric
                label="Total cost"
                value={`$${campaignTotals.cost.toFixed(2)}`}
                raw
              />
            </CardContent>
          </Card>
        ) : null}

        {campaign.stage_count_total === 0 && !stagesApi.isLoading ? (
          // Truly empty: no stages exist in this campaign at all.
          <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed py-10 text-center">
            <Send className="size-10 text-muted-foreground/40" aria-hidden />
            <div className="space-y-1">
              <p className="text-sm font-medium">No stages yet</p>
              <p className="text-sm text-muted-foreground">
                Each stage is a discrete SMS send to a slice of the frozen
                audience.
              </p>
            </div>
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
            ) : stages.length === 0 && !stagesApi.isLoading ? (
              // Filtered to zero: stages exist in this campaign, but the
              // current filter set hides all of them. Surface the count and
              // a one-click reset so the user isn't stranded.
              <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed py-10 text-center">
                <Send className="size-10 text-muted-foreground/40" aria-hidden />
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    No stages match the current filters
                  </p>
                  <p className="text-sm text-muted-foreground">
                    This campaign has {campaign.stage_count_total} stage
                    {campaign.stage_count_total === 1 ? "" : "s"} (
                    {rollupSubtitle.includes("—")
                      ? rollupSubtitle.split("—")[1]?.trim()
                      : ""}
                    ). Reset filters or toggle{" "}
                    <span className="font-mono">Show archived</span> to see
                    them.
                  </p>
                </div>
                {(stageFilters.statuses.length > 0 ||
                  stageFilters.showArchived) ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => resetStageFilters()}
                  >
                    Reset filters
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={refetchStages}>
                    Refresh
                  </Button>
                )}
              </div>
            ) : (
              <>
                {selectedStageIds.size > 0 ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                    <div>
                      <span className="font-medium">
                        {selectedStageIds.size}
                      </span>{" "}
                      stage{selectedStageIds.size === 1 ? "" : "s"} selected
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedStageIds(new Set())}
                        disabled={stageBulkBusy}
                      >
                        Clear
                      </Button>
                      {canSendStage ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => runStageBulk("success")}
                          disabled={stageBulkBusy}
                        >
                          Mark success
                        </Button>
                      ) : null}
                      {canSendStage ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => runStageBulk("failed")}
                          disabled={stageBulkBusy}
                        >
                          Mark failed
                        </Button>
                      ) : null}
                      {canSendStage ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => runStageBulk("cancelled")}
                          disabled={stageBulkBusy}
                        >
                          Mark cancelled
                        </Button>
                      ) : null}
                      {canArchiveStage ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => runStageBulk("archived")}
                          disabled={stageBulkBusy}
                        >
                          Archive
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                <DataTable<Stage>
                  data={stages}
                  columns={stageColumns}
                  isLoading={stagesApi.isLoading}
                  pageIndex={0}
                  pageSize={stageFilters.pageSize}
                  totalCount={stages.length}
                  onPageChange={() => {}}
                  onPageSizeChange={(s) => updateStageFilters({ pageSize: s })}
                  sortBy="stage_number"
                  sortDir="asc"
                  onSortChange={() => {}}
                  onRowClick={
                    canUpdateStage
                      ? (s) => {
                          setEditingStage(s);
                          setAddStageOpen(true);
                        }
                      : undefined
                  }
                  rowClassName={(s) => {
                    const op = stageOpStatus(s);
                    return op
                      ? cn("border-l-4", STAGE_STATUS_META[op].rowClass)
                      : undefined;
                  }}
                />
              </>
            )}
          </>
        )}

        {canCreateStage && campaign.status !== "archived" ? (
          <StageInlineEditor
            campaign={campaign}
            campaignId={campaignId}
            campaignTrackingId={campaign.tracking_id}
            nextStageNumber={
              stages.reduce((m, s) => Math.max(m, s.stage_number), 0) + 1
            }
            stage={editingStage}
            isOpen={addStageOpen}
            onOpenChange={(open) => {
              setAddStageOpen(open);
              if (!open) setEditingStage(null);
            }}
            onSaved={() => {
              refetchStages();
              refetchCampaign();
            }}
            onImportResults={
              canImportResults && editingStage
                ? () => {
                    setImportStage(editingStage);
                    setAddStageOpen(false);
                    setEditingStage(null);
                  }
                : undefined
            }
            onManualResults={
              canImportResults && editingStage
                ? () => {
                    setManualStage(editingStage);
                    setAddStageOpen(false);
                    setEditingStage(null);
                  }
                : undefined
            }
            onViewImportHistory={
              canViewImports && editingStage
                ? () => {
                    setHistoryStage(editingStage);
                    setAddStageOpen(false);
                    setEditingStage(null);
                  }
                : undefined
            }
            onBehavioralSplit={
              canCreateStage &&
              editingStage &&
              editingStage.behavioral_tier == null &&
              (lanesByParent.get(editingStage.id)?.length ?? 0) === 0
                ? () => {
                    // Close the editor, then open the shared confirm dialog with
                    // this stage — same flow as the stages-row action.
                    const s = editingStage;
                    setAddStageOpen(false);
                    setEditingStage(null);
                    setBehavioralSplitStage(s);
                  }
                : undefined
            }
          />
        ) : null}
      </section>

      {/* ============ Click attribution section ============ */}
      <section className="space-y-4">
        <ClickReportSection campaignId={campaignId} />
      </section>

      {/* ============ Activity log section ============ */}
      <section className="space-y-4">
        <CampaignActivitySection
          campaignId={campaignId}
          stages={stages.map((s) => ({
            id: s.id,
            stage_number: s.stage_number,
          }))}
        />
      </section>

      {/* ============ Dialogs ============ */}
      {/* Behavioral split confirm — mirrors the A/B split confirm flow. No
          input: it always stamps the three tier lanes off the chosen stage. */}
      <AlertDialog
        open={behavioralSplitStage !== null}
        onOpenChange={(open) => {
          if (!open) setBehavioralSplitStage(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Behavioral split — Stage {behavioralSplitStage?.stage_number}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This stamps out <span className="font-medium">three</span> lane
                  stages off this position — one each for{" "}
                  <span className="font-medium">Ignored</span>,{" "}
                  <span className="font-medium">Clicked</span>, and{" "}
                  <span className="font-medium">Reached offer</span>. Each lane
                  starts as a copy of this stage; edit its message afterward.
                </p>
                <p>
                  At send time each recipient who received this position falls
                  into exactly one lane by their current tier. Converted contacts
                  exit; opted-out are suppressed. This stage stays as the parent
                  position. Nothing is sent now.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={behavioralSplitApi.isLoading}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleBehavioralSplit();
              }}
              disabled={behavioralSplitApi.isLoading}
            >
              Create 3 lanes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* §A4: shared Prepare popup, opened from a stages-list Orange row. */}
      <StagePrepareDialog
        target={prepareTarget}
        onClose={() => setPrepareTarget(null)}
        onPrepared={() => {
          refetchStages();
          refetchCampaign();
        }}
      />

      <FormDialog
        open={sendStage !== null}
        onOpenChange={(open) => {
          if (!open) setSendStage(null);
        }}
        className="sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Send — Stage {sendStage?.stage_number}</DialogTitle>
          <DialogDescription>
            Approve, materialize + mint links, then send. Sending is gated and
            irreversible.
          </DialogDescription>
        </DialogHeader>
        {sendStage ? (
          <StageSendPanel campaignId={campaignId} stageId={sendStage.id} />
        ) : null}
      </FormDialog>

      {/* Upload contacts onto the campaign audience (draft only) */}
      <FormDialog
        open={uploadContactsOpen}
        onOpenChange={setUploadContactsOpen}
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Upload contacts to this campaign</DialogTitle>
          <DialogDescription>
            Paste or upload a CSV of phone numbers. New numbers are created,
            existing ones are reused, and all are tagged with the selected
            contact group(s) — which are added to this campaign&apos;s
            audience.
          </DialogDescription>
        </DialogHeader>
        <PhoneUploadForm
          endpoint={`/api/campaigns/${campaignId}/upload-contacts`}
          enableContactGroups
          requireContactGroups
          submitLabel="Upload to campaign"
          successLabel="Contacts uploaded to campaign"
          onSuccess={() => {
            toast.success("Audience updated");
            refetchCampaign();
          }}
          onCancel={() => setUploadContactsOpen(false)}
        />
      </FormDialog>

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

      {/* Import results — multi-step long-flow form, FormDialog gates dismissal */}
      <FormDialog
        open={importStage !== null}
        onOpenChange={(open) => {
          if (!open) setImportStage(null);
        }}
        className="max-h-[90vh] overflow-y-auto sm:max-w-4xl"
      >
        <DialogHeader>
          <DialogTitle>Import results (CSV)</DialogTitle>
          <DialogDescription>
            {importStage
              ? `Stage ${importStage.stage_number}${importStage.label ? ` · ${importStage.label}` : ""}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {importStage ? (
          <ResultsImportForm
            key={`import-${importStage.id}`}
            campaignId={campaignId}
            stageId={importStage.id}
            stage={{
              stage_number: importStage.stage_number,
              sms_provider_id: importStage.sms_provider_id,
              provider: importStage.provider,
            }}
            onClose={() => setImportStage(null)}
            onComplete={() => {
              refetchCampaign();
              refetchStages();
            }}
          />
        ) : null}
      </FormDialog>

      {/* Manual results entry — set the stage's totals by hand */}
      <FormDialog
        open={manualStage !== null}
        onOpenChange={(open) => {
          if (!open) setManualStage(null);
        }}
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>Enter results manually</DialogTitle>
          <DialogDescription>
            {manualStage
              ? `Stage ${manualStage.stage_number}${manualStage.label ? ` · ${manualStage.label}` : ""}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {manualStage ? (
          <ManualResultsForm
            key={`manual-${manualStage.id}`}
            campaignId={campaignId}
            stageId={manualStage.id}
            initial={{
              sms_count: manualStage.sms_count,
              delivered_count: manualStage.delivered_count,
              opt_out_count: manualStage.opt_out_count,
              click_count: manualStage.click_count,
              late_click_count: manualStage.late_click_count,
              scrubbed_count: manualStage.scrubbed_count,
              bounced_count: manualStage.bounced_count,
              checkout_click_count: manualStage.checkout_click_count,
              sales_count: manualStage.sales_count,
              total_cost: manualStage.total_cost,
            }}
            offerPayoutCpa={
              manualStage.offer?.payout_cpa != null
                ? Number(manualStage.offer.payout_cpa)
                : null
            }
            onClose={() => setManualStage(null)}
            onComplete={() => {
              refetchCampaign();
              refetchStages();
            }}
          />
        ) : null}
      </FormDialog>

      {/* Import history */}
      <FormDialog
        open={historyStage !== null}
        onOpenChange={(open) => {
          if (!open) setHistoryStage(null);
        }}
        className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle>Import history</DialogTitle>
          <DialogDescription>
            {historyStage
              ? `Stage ${historyStage.stage_number}${historyStage.label ? ` · ${historyStage.label}` : ""}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        {historyStage ? (
          <ImportHistoryDialog
            key={`history-${historyStage.id}`}
            campaignId={campaignId}
            stageId={historyStage.id}
            stageNumber={historyStage.stage_number}
            members={members.map((m) => ({
              user_id: m.id,
              display_name: m.display_name,
            }))}
            onClose={() => setHistoryStage(null)}
            onReverted={() => {
              refetchCampaign();
              refetchStages();
            }}
          />
        ) : null}
      </FormDialog>
    </div>
  );
}

// =============== Sub-components ===============

function TotalsMetric({
  label,
  value,
  raw,
}: {
  label: string;
  value: number | string;
  raw?: boolean;
}) {
  return (
    <div>
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="font-mono text-lg tabular-nums">
        {raw ? value : typeof value === "number" ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

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

function CampaignMetaCompact({
  campaign,
  memberLabel,
}: {
  campaign: CampaignDetail;
  memberLabel: (userId: string | null) => string | null;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const assigned = memberLabel(campaign.assigned_to_user_id) ?? "Unassigned";
  const createdBy = memberLabel(campaign.created_by_user_id) ?? "—";
  const createdDate = format(new Date(campaign.created_at), "MMM d, yyyy");
  const audienceCount = campaign.audience_snapshot_count;
  const capSuffix =
    campaign.audience_cap !== null
      ? ` (cap ${campaign.audience_cap.toLocaleString()})`
      : "";
  const dateRange =
    campaign.start_date || campaign.end_date
      ? `${campaign.start_date ?? "—"} → ${campaign.end_date ?? "—"}`
      : "—";

  return (
    <Card>
      <CardContent className="grid gap-2 p-4 text-sm">
        {/* Line 1: Brand · Offer · Routing */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {campaign.brand ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: campaign.brand.color ?? "#64748B" }}
                aria-hidden
              />
              <span className="font-medium">{campaign.brand.name}</span>
            </span>
          ) : null}
          {campaign.brand && campaign.offer ? (
            <span className="text-muted-foreground">·</span>
          ) : null}
          {campaign.offer ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: campaign.offer.color ?? "#64748B" }}
                aria-hidden
              />
              <span>{campaign.offer.name}</span>
            </span>
          ) : null}
          {campaign.routing_type ? (
            <>
              <span className="text-muted-foreground">·</span>
              <span>{campaign.routing_type.name}</span>
            </>
          ) : null}
        </div>

        {/* Line 2: Traffic · Assigned · Created · Audience · Tracking ID [Details ▾] */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>
            Traffic:{" "}
            <span className="text-foreground">
              {campaign.traffic_type?.name ?? "—"}
            </span>
          </span>
          <span>·</span>
          <span>
            Assigned: <span className="text-foreground">{assigned}</span>
          </span>
          <span>·</span>
          <span>
            Created <span className="text-foreground">{createdDate}</span>
          </span>
          <span>·</span>
          <span>
            Audience:{" "}
            <span className="font-mono tabular-nums text-foreground">
              {audienceCount.toLocaleString()}
            </span>{" "}
            frozen
            {capSuffix}
          </span>
          {campaign.tracking_id ? (
            <>
              <span>·</span>
              <span>
                Tracking:{" "}
                <button
                  type="button"
                  className="font-mono text-foreground hover:underline"
                  title="Click to copy"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(campaign.tracking_id as string)
                      .then(() => toast.success("Tracking ID copied"))
                      .catch(() => toast.error("Couldn't copy"));
                  }}
                >
                  {campaign.tracking_id}
                </button>
              </span>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => setShowDetails((s) => !s)}
            className="ml-auto inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
            aria-expanded={showDetails}
          >
            Details
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform",
                showDetails && "rotate-180",
              )}
              aria-hidden
            />
          </button>
        </div>

        {showDetails ? (
          <div className="grid gap-3 border-t pt-3 md:grid-cols-3">
            <MetaCell label="Created by" value={createdBy} />
            <MetaCell label="Start / End" value={dateRange} />
            <MetaCell
              label="Segments"
              value={
                campaign.audience_segment_ids.length > 0
                  ? campaign.audience_segment_ids.join(", ")
                  : "—"
              }
            />
            <MetaCell
              label="Contact groups"
              value={
                campaign.audience_contact_group_ids.length > 0
                  ? campaign.audience_contact_group_ids.join(", ")
                  : "—"
              }
            />
            <MetaCell
              label="Audience cap"
              value={
                campaign.audience_cap !== null
                  ? campaign.audience_cap.toLocaleString()
                  : "None"
              }
            />
            <MetaCell
              label="Filters"
              value={
                <span className="font-mono text-xs">
                  {Object.entries(campaign.audience_filters)
                    .filter(([, v]) => v === true)
                    .map(([k]) => k.replace(/^include_/, ""))
                    .join(", ") || "—"}
                </span>
              }
            />
            <MetaCell
              label="Exclude in-use"
              value={campaign.exclude_in_use_contacts ? "Yes" : "No"}
            />
          </div>
        ) : null}

        {campaign.notes ? (
          <div className="border-t pt-3">
            <div className="text-xs uppercase text-muted-foreground">
              Notes
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm">
              {campaign.notes}
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
